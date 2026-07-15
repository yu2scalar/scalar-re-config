/*
 * Copyright 2026 Scalar Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.scalar.re.configtool.service;

import com.scalar.db.api.DistributedTransactionAdmin;
import com.scalar.db.service.TransactionFactory;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeSet;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.stereotype.Service;

/**
 * <b>Non-destructive</b> DB connectivity check using the generated config.
 *
 * <p>Flow: config → resolve {@code ${VAR:default}} via {@link PlaceholderResolver}
 * → generate properties via {@link GeneratorService#toScalarDbProperties}
 * → {@code TransactionFactory.create(props).getTransactionAdmin()}
 * → a single {@code getNamespaceNames()} call (read only, no schema changes).
 *
 * <p>Actual schema creation (init) is handled by {@link SchemaInitService}; this class only
 * determines whether the real DB is reachable with the config.
 */
@Service
public class DbVerifyService {

    private final GeneratorService generator;
    private final PlaceholderResolver resolver;

    public DbVerifyService(GeneratorService generator, PlaceholderResolver resolver) {
        this.generator = generator;
        this.resolver = resolver;
    }

    /**
     * Connectivity check result.
     *
     * @param reachable   whether the connection succeeded and the namespace list was fetched
     * @param namespaces  fetched namespace names (only when reachable; may be empty)
     * @param elapsedMs   time from connect to fetch in ms
     * @param errorType   exception class name on failure (null on success)
     * @param errorMessage failure message (null on success)
     */
    /**
     * @param target actual connection target <b>after</b> placeholder resolution (for UI display:
     *               shows what was attempted and makes env overrides visible)
     */
    public record VerifyResult(
            boolean reachable,
            List<String> namespaces,
            long elapsedMs,
            String target,
            String errorType,
            String errorMessage) {}

    /** Overall timeout in ms. Prevents JDBC connect from hanging on unreachable hosts. Overridable via env. */
    private static final long TIMEOUT_MS = resolveTimeoutMs();

    /** Connectivity check over the whole config (multi-storage). */
    public VerifyResult verify(Map<String, Object> config) {
        Map<String, Object> resolved = resolver.resolve(config);
        Map<String, Object> storages = ConfigMaps.getMap(resolved, "storages");
        int n = storages == null ? 0 : storages.size();
        return runVerify(generator.toScalarDbProperties(resolved), "multi-storage (" + n + " storages)");
    }

    /**
     * Connectivity check for a single storage. Builds the admin from properties for that
     * storage only. An undefined storage name yields reachable:false (error).
     */
    public VerifyResult verifyStorage(Map<String, Object> config, String storageName) {
        Map<String, Object> resolved = resolver.resolve(config);
        Map<String, Object> storages = ConfigMaps.getMap(resolved, "storages");
        Map<String, Object> st = ConfigMaps.getMap(storages, storageName);
        if (st == null) {
            return new VerifyResult(false, List.of(), 0L, null, "NotFound",
                    "Storage '" + storageName + "' is not defined in config");
        }
        return runVerify(generator.singleStorageProperties(st), generator.connectionTarget(st));
    }

    /** Shared logic: builds an admin from a properties string and runs getNamespaceNames() with a timeout. */
    private VerifyResult runVerify(String propsText, String target) {
        Properties props = new Properties();
        try {
            props.load(new StringReader(propsText));
        } catch (Exception e) {
            return new VerifyResult(false, List.of(), 0L, target,
                    e.getClass().getSimpleName(), "Failed to parse generated properties: " + e.getMessage());
        }

        long t0 = System.nanoTime();
        // The admin is created inside the worker thread; share it so it can be closed from outside on timeout.
        AtomicReference<DistributedTransactionAdmin> adminRef = new AtomicReference<>();
        ExecutorService exec = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "db-verify");
            t.setDaemon(true);
            return t;
        });
        try {
            Future<List<String>> future = exec.submit(() -> {
                // TransactionFactory itself needs no close. The created admin holds the
                // resources and admin.close() releases them (ScalarDB 3.x).
                DistributedTransactionAdmin admin = TransactionFactory.create(props).getTransactionAdmin();
                adminRef.set(admin);
                return new ArrayList<>(new TreeSet<>(admin.getNamespaceNames()));
            });
            try {
                List<String> names = future.get(TIMEOUT_MS, TimeUnit.MILLISECONDS);
                long ms = (System.nanoTime() - t0) / 1_000_000;
                return new VerifyResult(true, names, ms, target, null, null);
            } catch (TimeoutException te) {
                future.cancel(true);
                long ms = (System.nanoTime() - t0) / 1_000_000;
                return new VerifyResult(false, List.of(), ms, target, "TimeoutException",
                        "DB verify timed out after " + TIMEOUT_MS + "ms (host unreachable?)");
            } catch (ExecutionException ee) {
                long ms = (System.nanoTime() - t0) / 1_000_000;
                Throwable root = rootCause(ee);
                return new VerifyResult(false, List.of(), ms, target,
                        root.getClass().getSimpleName(), root.getMessage());
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                long ms = (System.nanoTime() - t0) / 1_000_000;
                return new VerifyResult(false, List.of(), ms, target, "InterruptedException", ie.getMessage());
            }
        } finally {
            closeQuietly(adminRef.get());
            exec.shutdownNow();
        }
    }

    private static long resolveTimeoutMs() {
        String v = System.getenv("CONFIG_TOOL_DB_VERIFY_TIMEOUT_MS");
        if (v != null) {
            try {
                return Long.parseLong(v.trim());
            } catch (NumberFormatException ignored) {
                // fall through to default
            }
        }
        return 10_000L;
    }

    private static Throwable rootCause(Throwable t) {
        Throwable cur = t;
        while (cur.getCause() != null && cur.getCause() != cur) {
            cur = cur.getCause();
        }
        return cur;
    }

    private static void closeQuietly(AutoCloseable c) {
        if (c != null) {
            try {
                c.close();
            } catch (Exception ignored) {
                // best-effort cleanup
            }
        }
    }
}
