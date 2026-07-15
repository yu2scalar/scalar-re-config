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

import static com.scalar.re.configtool.service.ConfigMaps.getMap;
import static com.scalar.re.configtool.service.ConfigMaps.getString;

import com.scalar.db.api.DistributedTransactionAdmin;
import com.scalar.db.api.TableMetadata;
import com.scalar.db.service.TransactionFactory;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.stereotype.Service;

/**
 * Creates the RE schema from the generated config.
 * A port of the ScalarRE core product's {@code SchemaInitializer.createAll / dropAndRecreateAll}.
 *
 * <ul>
 *   <li><b>create</b> (default, idempotent): coordinator + the 4 management tables + queue-ns re_hold +
 *       outbox/inbox/hold for each namespace + a tx_state index on every table. ifNotExists.</li>
 *   <li><b>recreate</b> (destructive): drops the management/event tables, then recreates them. The
 *       coordinator is never dropped. Requires explicit opt-in (guarded by the caller).</li>
 * </ul>
 *
 * <p>Admin construction is the same as verify (resolve → toScalarDbProperties → getTransactionAdmin).
 * DynamoDB Local (a dynamo namespace with endpoint-override set) is passed {no-scaling,no-backup}.
 */
@Service
public class SchemaInitService {

    private static final long TIMEOUT_MS = resolveTimeoutMs();
    private static final Map<String, String> DYNAMO_LOCAL_OPTIONS =
            Map.of("no-scaling", "true", "no-backup", "true");

    private final GeneratorService generator;
    private final PlaceholderResolver resolver;

    public SchemaInitService(GeneratorService generator, PlaceholderResolver resolver) {
        this.generator = generator;
        this.resolver = resolver;
    }

    /**
     * @param ok        whether the operation succeeded
     * @param mode      "create" or "recreate"
     * @param created   tables created (ns.table / "coordinator")
     * @param skipped   tables skipped because they already existed
     * @param dropped   tables dropped during recreate
     * @param indexes   tx_state indexes created/confirmed (ns.table.tx_state)
     */
    public record InitResult(
            boolean ok,
            String mode,
            List<String> created,
            List<String> skipped,
            List<String> dropped,
            List<String> indexes,
            long elapsedMs,
            String errorType,
            String errorMessage) {}

    public InitResult init(Map<String, Object> config, boolean recreate) {
        Map<String, Object> resolved = resolver.resolve(config);
        String propsText = generator.toScalarDbProperties(resolved);
        Properties props = new Properties();
        try {
            props.load(new StringReader(propsText));
        } catch (Exception e) {
            return fail(recreate, e, 0L);
        }

        long t0 = System.nanoTime();
        Run run = new Run(resolved);
        ExecutorService exec = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "db-init");
            t.setDaemon(true);
            return t;
        });
        try {
            Future<Void> future = exec.submit((Callable<Void>) () -> {
                run.admin = TransactionFactory.create(props).getTransactionAdmin();
                if (recreate) {
                    run.dropAndRecreateAll();
                } else {
                    run.createAll();
                }
                return null;
            });
            try {
                future.get(TIMEOUT_MS, TimeUnit.MILLISECONDS);
                long ms = elapsedMs(t0);
                return new InitResult(true, mode(recreate), run.created, run.skipped, run.dropped,
                        run.indexes, ms, null, null);
            } catch (TimeoutException te) {
                future.cancel(true);
                return failPartial(recreate, run, "TimeoutException",
                        "DB init timed out after " + TIMEOUT_MS + "ms", elapsedMs(t0));
            } catch (ExecutionException ee) {
                Throwable root = rootCause(ee);
                return failPartial(recreate, run, root.getClass().getSimpleName(), root.getMessage(),
                        elapsedMs(t0));
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return failPartial(recreate, run, "InterruptedException", ie.getMessage(), elapsedMs(t0));
            }
        } finally {
            closeQuietly(run.admin);
            exec.shutdownNow();
        }
    }

    // ---------------------------------------------------------------------
    // State of a single init run (admin is used inside the worker thread)
    // ---------------------------------------------------------------------
    private final class Run {
        final Map<String, Object> config;
        DistributedTransactionAdmin admin;
        final List<String> created = Collections.synchronizedList(new ArrayList<>());
        final List<String> skipped = Collections.synchronizedList(new ArrayList<>());
        final List<String> dropped = Collections.synchronizedList(new ArrayList<>());
        final List<String> indexes = Collections.synchronizedList(new ArrayList<>());

        Run(Map<String, Object> config) {
            this.config = config;
        }

        void createAll() throws Exception {
            admin.createCoordinatorTables(true);
            created.add("coordinator");

            // Management tables
            createReTable(ReSchema.NODE_HEARTBEAT, ReSchema.nodeHeartbeat());
            createReTable(ReSchema.RE_COMPLETED, ReSchema.reCompleted());
            createReTable(ReSchema.RE_QUEUE, ReSchema.reQueue());
            createReTable(ReSchema.RE_SUBSCRIPTION, ReSchema.reSubscription());
            // queue-ns re_hold
            String queueNs = reTableNamespace(ReSchema.RE_QUEUE);
            createTable(queueNs, ReSchema.HOLD, ReSchema.hold());
            // tx_state index (4 management tables + queue re_hold)
            indexTxState(reTableNamespace(ReSchema.NODE_HEARTBEAT), ReSchema.NODE_HEARTBEAT);
            indexTxState(reTableNamespace(ReSchema.RE_COMPLETED), ReSchema.RE_COMPLETED);
            indexTxState(reTableNamespace(ReSchema.RE_QUEUE), ReSchema.RE_QUEUE);
            indexTxState(reTableNamespace(ReSchema.RE_SUBSCRIPTION), ReSchema.RE_SUBSCRIPTION);
            indexTxState(queueNs, ReSchema.HOLD);

            // Each event namespace
            for (String ns : eventNamespaces()) {
                createNamespace(ns);
                createTable(ns, ReSchema.OUTBOX, ReSchema.outbox());
                createTable(ns, ReSchema.INBOX, ReSchema.inbox());
                createTable(ns, ReSchema.HOLD, ReSchema.hold());
                indexTxState(ns, ReSchema.OUTBOX);
                indexTxState(ns, ReSchema.INBOX);
                indexTxState(ns, ReSchema.HOLD);
            }
        }

        void dropAndRecreateAll() throws Exception {
            admin.createCoordinatorTables(true);

            dropAndRecreateReTable(ReSchema.NODE_HEARTBEAT, ReSchema.nodeHeartbeat());
            dropAndRecreateReTable(ReSchema.RE_COMPLETED, ReSchema.reCompleted());
            dropAndRecreateReTable(ReSchema.RE_QUEUE, ReSchema.reQueue());
            dropAndRecreateReTable(ReSchema.RE_SUBSCRIPTION, ReSchema.reSubscription());
            String queueNs = reTableNamespace(ReSchema.RE_QUEUE);
            createNamespace(queueNs);
            dropAndRecreate(queueNs, ReSchema.HOLD, ReSchema.hold());
            indexTxState(reTableNamespace(ReSchema.NODE_HEARTBEAT), ReSchema.NODE_HEARTBEAT);
            indexTxState(reTableNamespace(ReSchema.RE_COMPLETED), ReSchema.RE_COMPLETED);
            indexTxState(reTableNamespace(ReSchema.RE_QUEUE), ReSchema.RE_QUEUE);
            indexTxState(reTableNamespace(ReSchema.RE_SUBSCRIPTION), ReSchema.RE_SUBSCRIPTION);
            indexTxState(queueNs, ReSchema.HOLD);

            for (String ns : eventNamespaces()) {
                createNamespace(ns);
                dropAndRecreate(ns, ReSchema.OUTBOX, ReSchema.outbox());
                dropAndRecreate(ns, ReSchema.INBOX, ReSchema.inbox());
                dropAndRecreate(ns, ReSchema.HOLD, ReSchema.hold());
                indexTxState(ns, ReSchema.OUTBOX);
                indexTxState(ns, ReSchema.INBOX);
                indexTxState(ns, ReSchema.HOLD);
            }
        }

        // --- creation helpers ---

        private void createReTable(String table, TableMetadata md) throws Exception {
            String ns = reTableNamespace(table);
            createNamespace(ns);
            createTable(ns, table, md);
        }

        private void dropAndRecreateReTable(String table, TableMetadata md) throws Exception {
            String ns = reTableNamespace(table);
            createNamespace(ns);
            dropAndRecreate(ns, table, md);
        }

        private void createNamespace(String ns) throws Exception {
            if (admin.namespaceExists(ns)) {
                return;
            }
            try {
                if (isDynamoLocal(ns)) {
                    admin.createNamespace(ns, true, DYNAMO_LOCAL_OPTIONS);
                } else {
                    admin.createNamespace(ns, true);
                }
            } catch (Exception e) {
                if (!containsAlreadyExists(e)) {
                    throw e;
                }
            }
        }

        private void createTable(String ns, String table, TableMetadata md) throws Exception {
            boolean existed = admin.tableExists(ns, table);
            try {
                if (isDynamoLocal(ns)) {
                    admin.createTable(ns, table, md, true, DYNAMO_LOCAL_OPTIONS);
                } else {
                    admin.createTable(ns, table, md, true);
                }
            } catch (Exception e) {
                if (!containsAlreadyExists(e)) {
                    throw e;
                }
            }
            (existed ? skipped : created).add(ns + "." + table);
        }

        private void dropAndRecreate(String ns, String table, TableMetadata md) throws Exception {
            try {
                admin.dropTable(ns, table);
                dropped.add(ns + "." + table);
            } catch (Exception e) {
                if (!isTableNotFound(e)) {
                    throw e;
                }
            }
            if (isDynamoLocal(ns)) {
                admin.createTable(ns, table, md, DYNAMO_LOCAL_OPTIONS);
            } else {
                admin.createTable(ns, table, md);
            }
            created.add(ns + "." + table);
        }

        private void indexTxState(String ns, String table) throws Exception {
            Map<String, String> options = isDynamoLocal(ns) ? DYNAMO_LOCAL_OPTIONS : Map.of();
            try {
                admin.createIndex(ns, table, ReSchema.TX_STATE, true, options);
                indexes.add(ns + "." + table + "." + ReSchema.TX_STATE);
            } catch (Exception e) {
                if (containsAlreadyExists(e)) {
                    indexes.add(ns + "." + table + "." + ReSchema.TX_STATE);
                    return;
                }
                throw e;
            }
        }

        // --- namespace resolution from config ---

        /** Namespace of a management table (global.re-tables.<table>.namespace; defaults to scalarre). */
        private String reTableNamespace(String table) {
            Map<String, Object> reTables = getMap(getMap(config, "global"), "re-tables");
            String ns = getString(getMap(reTables, table), "namespace");
            return ns.isEmpty() ? "scalarre" : ns;
        }

        /** All keys of config.namespaces. */
        private List<String> eventNamespaces() {
            Map<String, Object> namespaces = getMap(config, "namespaces");
            return namespaces == null ? List.of() : new ArrayList<>(namespaces.keySet());
        }

        /** Treated as DynamoDB Local if the namespace's storage is dynamo with endpoint-override set. */
        private boolean isDynamoLocal(String ns) {
            Map<String, Object> namespaces = getMap(config, "namespaces");
            String storageName = getString(getMap(namespaces, ns), "storage");
            if (storageName.isEmpty()) {
                return false;
            }
            Map<String, Object> storage = getMap(getMap(config, "storages"), storageName);
            if (!getString(storage, "type").equals("dynamo")) {
                return false;
            }
            return !getString(getMap(storage, "options"), "endpoint-override").isEmpty();
        }
    }

    // =====================================================================
    // per-resource operations (per-namespace status / create / recreate)
    // =====================================================================

    public record TableState(String table, boolean exists) {}

    public record NamespaceStatus(boolean ok, boolean namespaceExists, List<TableState> tables,
            boolean healthy, long elapsedMs, String target, String errorType, String errorMessage) {}

    public record NamespaceOp(boolean ok, String mode, List<String> created, List<String> skipped,
            List<String> dropped, List<String> indexes, long elapsedMs, String target,
            String errorType, String errorMessage) {}

    /** Table name → metadata. */
    private static TableMetadata metadataFor(String table) {
        return switch (table) {
            case ReSchema.OUTBOX -> ReSchema.outbox();
            case ReSchema.INBOX -> ReSchema.inbox();
            case ReSchema.HOLD -> ReSchema.hold();
            case ReSchema.NODE_HEARTBEAT -> ReSchema.nodeHeartbeat();
            case ReSchema.RE_COMPLETED -> ReSchema.reCompleted();
            case ReSchema.RE_QUEUE -> ReSchema.reQueue();
            case ReSchema.RE_SUBSCRIPTION -> ReSchema.reSubscription();
            default -> throw new IllegalArgumentException("Unknown RE table: " + table);
        };
    }

    /**
     * Expected RE table set for a namespace: base [outbox, inbox, hold] plus any
     * management tables placed in that namespace (global.re-tables.<t>.namespace==ns).
     * Same set as the RE core verifySchema.
     */
    private List<String> expectedTables(Map<String, Object> config, String ns) {
        List<String> out = new ArrayList<>(List.of(ReSchema.OUTBOX, ReSchema.INBOX, ReSchema.HOLD));
        Map<String, Object> reTables = getMap(getMap(config, "global"), "re-tables");
        for (String t : List.of(ReSchema.NODE_HEARTBEAT, ReSchema.RE_COMPLETED,
                ReSchema.RE_QUEUE, ReSchema.RE_SUBSCRIPTION)) {
            String tns = getString(getMap(reTables, t), "namespace");
            if (tns.isEmpty()) {
                tns = "scalarre";
            }
            if (tns.equals(ns)) {
                out.add(t);
            }
        }
        return out;
    }

    private static boolean isDynamoLocalNs(Map<String, Object> config, String ns) {
        Map<String, Object> namespaces = getMap(config, "namespaces");
        String storageName = getString(getMap(namespaces, ns), "storage");
        if (storageName.isEmpty()) {
            return false;
        }
        Map<String, Object> storage = getMap(getMap(config, "storages"), storageName);
        if (!getString(storage, "type").equals("dynamo")) {
            return false;
        }
        return !getString(getMap(storage, "options"), "endpoint-override").isEmpty();
    }

    private record NsStatusData(boolean nsExists, List<TableState> tables) {}

    /** status — returns namespace existence plus existence of each expected table (non-destructive). */
    public NamespaceStatus namespaceStatus(Map<String, Object> config, String ns) {
        Map<String, Object> resolved = resolver.resolve(config);
        Map<String, Object> storage = nsStorage(resolved, ns);
        if (storage == null) {
            return new NamespaceStatus(false, false, List.of(), false, 0L, null, "NotFound",
                    "Namespace '" + ns + "' has no storage defined in config");
        }
        String target = generator.connectionTarget(storage);
        List<String> expected = expectedTables(resolved, ns);
        AdminOutcome<NsStatusData> o = execute(generator.singleStorageProperties(storage), admin -> {
            boolean nsEx = admin.namespaceExists(ns);
            List<TableState> tables = new ArrayList<>();
            for (String t : expected) {
                tables.add(new TableState(t, nsEx && admin.tableExists(ns, t)));
            }
            return new NsStatusData(nsEx, tables);
        });
        if (!o.ok()) {
            return new NamespaceStatus(false, false, List.of(), false, o.elapsedMs(),
                    target, o.errorType(), o.errorMessage());
        }
        boolean nsEx = o.value().nsExists();
        List<TableState> tables = o.value().tables();
        boolean healthy = nsEx && !tables.isEmpty() && tables.stream().allMatch(TableState::exists);
        return new NamespaceStatus(true, nsEx, tables, healthy, o.elapsedMs(), target, null, null);
    }

    /** create — namespace + expected tables + tx_state indexes (idempotent). */
    public NamespaceOp createNamespace(Map<String, Object> config, String ns) {
        Map<String, Object> resolved = resolver.resolve(config);
        Map<String, Object> storage = nsStorage(resolved, ns);
        if (storage == null) {
            return new NamespaceOp(false, "create", List.of(), List.of(), List.of(), List.of(), 0L,
                    null, "NotFound", "Namespace '" + ns + "' has no storage defined in config");
        }
        String target = generator.connectionTarget(storage);
        List<String> expected = expectedTables(resolved, ns);
        boolean dyn = isDynamoLocalNs(resolved, ns);
        List<String> created = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        List<String> indexes = new ArrayList<>();
        AdminOutcome<Void> o = execute(generator.singleStorageProperties(storage), admin -> {
            doEnsureNamespace(admin, ns, dyn);
            for (String t : expected) {
                boolean existed = admin.tableExists(ns, t);
                doCreateTable(admin, ns, t, metadataFor(t), dyn);
                (existed ? skipped : created).add(ns + "." + t);
                doIndexTxState(admin, ns, t, dyn);
                indexes.add(ns + "." + t + "." + ReSchema.TX_STATE);
            }
            return null;
        });
        return new NamespaceOp(o.ok(), "create", created, skipped, List.of(), indexes,
                o.elapsedMs(), target, o.errorType(), o.errorMessage());
    }

    /** recreate — drop expected tables → drop namespace → recreate (destructive). */
    public NamespaceOp recreateNamespace(Map<String, Object> config, String ns) {
        Map<String, Object> resolved = resolver.resolve(config);
        Map<String, Object> storage = nsStorage(resolved, ns);
        if (storage == null) {
            return new NamespaceOp(false, "recreate", List.of(), List.of(), List.of(), List.of(), 0L,
                    null, "NotFound", "Namespace '" + ns + "' has no storage defined in config");
        }
        String target = generator.connectionTarget(storage);
        List<String> expected = expectedTables(resolved, ns);
        boolean dyn = isDynamoLocalNs(resolved, ns);
        List<String> dropped = new ArrayList<>();
        List<String> created = new ArrayList<>();
        List<String> indexes = new ArrayList<>();
        AdminOutcome<Void> o = execute(generator.singleStorageProperties(storage), admin -> {
            for (String t : expected) {
                if (doDropTable(admin, ns, t)) {
                    dropped.add(ns + "." + t);
                }
            }
            // The namespace can be dropped once all its tables have been dropped
            try {
                if (admin.namespaceExists(ns)) {
                    admin.dropNamespace(ns);
                }
            } catch (Exception e) {
                // If it fails (e.g. leftover tables remain), ignore and proceed to recreate
            }
            doEnsureNamespace(admin, ns, dyn);
            for (String t : expected) {
                doCreateTable(admin, ns, t, metadataFor(t), dyn);
                created.add(ns + "." + t);
                doIndexTxState(admin, ns, t, dyn);
                indexes.add(ns + "." + t + "." + ReSchema.TX_STATE);
            }
            return null;
        });
        return new NamespaceOp(o.ok(), "recreate", created, List.of(), dropped, indexes,
                o.elapsedMs(), target, o.errorType(), o.errorMessage());
    }

    // --- shared per-resource plumbing: admin lifecycle + timeout ---

    private interface AdminTask<T> {
        T run(DistributedTransactionAdmin admin) throws Exception;
    }

    private record AdminOutcome<T>(boolean ok, T value, long elapsedMs, String errorType, String errorMessage) {}

    /**
     * Properties for the namespace's storage alone; null if the storage is undefined.
     * Per-namespace operations must look only at the storage the namespace belongs to;
     * building an admin over the whole config (multi-storage) would fail on unrelated
     * unreachable storages (UnknownHostException etc.).
     */
    /** Storage map the namespace belongs to (after resolution); null if undefined. */
    private Map<String, Object> nsStorage(Map<String, Object> resolved, String ns) {
        Map<String, Object> storages = getMap(resolved, "storages");
        Map<String, Object> namespaces = getMap(resolved, "namespaces");
        String storageName = getString(getMap(namespaces, ns), "storage");
        return getMap(storages, storageName);
    }

    private <T> AdminOutcome<T> execute(String propsText, AdminTask<T> task) {
        Properties props = new Properties();
        try {
            props.load(new StringReader(propsText));
        } catch (Exception e) {
            return new AdminOutcome<>(false, null, 0L, e.getClass().getSimpleName(),
                    "Failed to parse generated properties: " + e.getMessage());
        }
        long t0 = System.nanoTime();
        AtomicReference<DistributedTransactionAdmin> adminRef = new AtomicReference<>();
        ExecutorService exec = Executors.newSingleThreadExecutor(r -> {
            Thread th = new Thread(r, "db-op");
            th.setDaemon(true);
            return th;
        });
        try {
            Future<T> future = exec.submit(() -> {
                DistributedTransactionAdmin admin = TransactionFactory.create(props).getTransactionAdmin();
                adminRef.set(admin);
                return task.run(admin);
            });
            try {
                T value = future.get(TIMEOUT_MS, TimeUnit.MILLISECONDS);
                return new AdminOutcome<>(true, value, elapsedMs(t0), null, null);
            } catch (TimeoutException te) {
                future.cancel(true);
                return new AdminOutcome<>(false, null, elapsedMs(t0), "TimeoutException",
                        "DB operation timed out after " + TIMEOUT_MS + "ms");
            } catch (ExecutionException ee) {
                Throwable root = rootCause(ee);
                return new AdminOutcome<>(false, null, elapsedMs(t0),
                        root.getClass().getSimpleName(), root.getMessage());
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return new AdminOutcome<>(false, null, elapsedMs(t0), "InterruptedException", ie.getMessage());
            }
        } finally {
            closeQuietly(adminRef.get());
            exec.shutdownNow();
        }
    }

    private static void doEnsureNamespace(DistributedTransactionAdmin admin, String ns, boolean dyn)
            throws Exception {
        if (admin.namespaceExists(ns)) {
            return;
        }
        try {
            if (dyn) {
                admin.createNamespace(ns, true, DYNAMO_LOCAL_OPTIONS);
            } else {
                admin.createNamespace(ns, true);
            }
        } catch (Exception e) {
            if (!containsAlreadyExists(e)) {
                throw e;
            }
        }
    }

    private static void doCreateTable(DistributedTransactionAdmin admin, String ns, String table,
            TableMetadata md, boolean dyn) throws Exception {
        try {
            if (dyn) {
                admin.createTable(ns, table, md, true, DYNAMO_LOCAL_OPTIONS);
            } else {
                admin.createTable(ns, table, md, true);
            }
        } catch (Exception e) {
            if (!containsAlreadyExists(e)) {
                throw e;
            }
        }
    }

    private static void doIndexTxState(DistributedTransactionAdmin admin, String ns, String table, boolean dyn)
            throws Exception {
        Map<String, String> options = dyn ? DYNAMO_LOCAL_OPTIONS : Map.of();
        try {
            admin.createIndex(ns, table, ReSchema.TX_STATE, true, options);
        } catch (Exception e) {
            if (!containsAlreadyExists(e)) {
                throw e;
            }
        }
    }

    /** Drops the table. Returns false if it did not exist (no-op), true if dropped. */
    private static boolean doDropTable(DistributedTransactionAdmin admin, String ns, String table)
            throws Exception {
        try {
            admin.dropTable(ns, table);
            return true;
        } catch (Exception e) {
            if (isTableNotFound(e)) {
                return false;
            }
            throw e;
        }
    }

    // ---------------------------------------------------------------------
    // Exception classification (same shape as the RE core)
    // ---------------------------------------------------------------------

    private static boolean containsAlreadyExists(Throwable t) {
        while (t != null) {
            String msg = t.getMessage();
            if (msg != null) {
                String lower = msg.toLowerCase();
                if (lower.contains("already exists")
                        || lower.contains("cannot create preexisting table")
                        || lower.contains("resourceinuseexception")
                        || lower.contains("table already exists")) {
                    return true;
                }
            }
            if (t.getClass().getSimpleName().equals("ResourceInUseException")) {
                return true;
            }
            t = t.getCause();
        }
        return false;
    }

    private static boolean isTableNotFound(Throwable t) {
        while (t != null) {
            String msg = t.getMessage();
            if (msg != null) {
                String lower = msg.toLowerCase();
                if (lower.contains("the table does not exist")
                        || lower.contains("non-existent table")
                        || lower.contains("table not found")) {
                    return true;
                }
            }
            t = t.getCause();
        }
        return false;
    }

    // ---------------------------------------------------------------------
    // Result helpers
    // ---------------------------------------------------------------------

    private static String mode(boolean recreate) {
        return recreate ? "recreate" : "create";
    }

    private static long elapsedMs(long t0) {
        return (System.nanoTime() - t0) / 1_000_000;
    }

    private static InitResult fail(boolean recreate, Throwable e, long ms) {
        Throwable root = rootCause(e);
        return new InitResult(false, mode(recreate), List.of(), List.of(), List.of(), List.of(), ms,
                root.getClass().getSimpleName(), "Failed to parse generated properties: " + root.getMessage());
    }

    private static InitResult failPartial(boolean recreate, Run run, String type, String message, long ms) {
        // Keep whatever was created/dropped so far in the lists (makes partial application visible)
        return new InitResult(false, mode(recreate),
                new ArrayList<>(run.created), new ArrayList<>(run.skipped),
                new ArrayList<>(run.dropped), new ArrayList<>(run.indexes), ms, type, message);
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
                // best-effort
            }
        }
    }

    private static long resolveTimeoutMs() {
        String v = System.getenv("CONFIG_TOOL_DB_INIT_TIMEOUT_MS");
        if (v != null) {
            try {
                return Long.parseLong(v.trim());
            } catch (NumberFormatException ignored) {
                // default
            }
        }
        return 120_000L;
    }
}
