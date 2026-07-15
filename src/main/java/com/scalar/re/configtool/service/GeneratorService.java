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

import static com.scalar.re.configtool.service.ConfigMaps.getInt;
import static com.scalar.re.configtool.service.ConfigMaps.getMap;
import static com.scalar.re.configtool.service.ConfigMaps.getString;
import static com.scalar.re.configtool.service.ConfigMaps.sortedKeys;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.yaml.snakeyaml.DumperOptions;
import org.yaml.snakeyaml.Yaml;

/**
 * Conversion between the unified config and generated artifacts. A port of the original
 * Go prototype's {@code internal/generator/generator.go}.
 *
 * <ul>
 *   <li>{@link #toScalarDbProperties} — preview. Must match the Go output <b>exactly at the
 *       string level</b> (deterministic line assembly).</li>
 *   <li>{@link #saveYaml} — save. YAML output follows a <b>clean normalization policy</b>:
 *       large integers stay as plain integers (the scientific notation {@code 8.64e+07}
 *       of Go yaml.v3 is not adopted). Top-level keys use a fixed order, nested keys are
 *       sorted ascending, indent=4. Golden files are re-frozen from this Java output.</li>
 *   <li>{@link #loadYaml} — load. YAML → Map, migrating legacy storage fields.</li>
 *   <li>{@link #importLegacy} — unimplemented stub, same as the Go version (parity kept).</li>
 * </ul>
 */
@Service
public class GeneratorService {

    private static final List<String> TOP_LEVEL_KEYS =
            List.of("schema-version", "global", "scalardb", "storages", "namespaces");

    // ---------------------------------------------------------------------
    // preview : scalardb.properties (exact match with the Go output)
    // ---------------------------------------------------------------------

    public String toScalarDbProperties(Map<String, Object> config) {
        List<String> lines = new ArrayList<>();

        Map<String, Object> storages = getMap(config, "storages");
        Map<String, Object> namespaces = getMap(config, "namespaces");
        Map<String, Object> scalardb = getMap(config, "scalardb");

        List<String> storageNames = sortedKeys(storages);

        // Core settings
        if (storageNames.size() > 1) {
            lines.add("scalar.db.storage=multi-storage");
        } else if (storageNames.size() == 1) {
            Map<String, Object> st = getMap(storages, storageNames.get(0));
            lines.add("scalar.db.storage=" + getString(st, "type"));
        }

        String txManager = "consensus-commit";
        String isolationLevel = "READ_COMMITTED";
        String defaultStorage = "";
        if (scalardb != null) {
            String v = getString(scalardb, "transaction-manager");
            if (!v.isEmpty()) {
                txManager = v;
            }
            String il = getString(scalardb, "isolation-level");
            if (!il.isEmpty()) {
                isolationLevel = il;
            }
            defaultStorage = getString(scalardb, "default-storage");
        }
        lines.add("scalar.db.transaction_manager=" + txManager);
        lines.add("scalar.db.consensus_commit.isolation_level=" + isolationLevel);

        // Multi-storage storages list
        if (storageNames.size() > 1) {
            lines.add("scalar.db.multi_storage.storages=" + String.join(",", storageNames));
            lines.add("");
        }

        // Per-storage config
        for (String name : storageNames) {
            Map<String, Object> st = getMap(storages, name);
            String prefix = "scalar.db.multi_storage.storages." + name;

            String storageType = getString(st, "type");
            String contactPoints = buildContactPoints(st);
            String username = getUsername(st);
            String password = getPassword(st);

            lines.add("# " + name);
            lines.add(prefix + ".storage=" + storageType);
            lines.add(prefix + ".contact_points=" + contactPoints);
            lines.add(prefix + ".username=" + username);
            lines.add(prefix + ".password=" + password);

            // RE-required settings
            lines.add(prefix + ".cross_partition_scan.enabled=true");
            if (storageType.equals("jdbc")) {
                lines.add(prefix + ".cross_partition_scan.filtering.enabled=true");
                lines.add(prefix + ".cross_partition_scan.ordering.enabled=true");
            }

            // Options (same order as the Go if-chain)
            Map<String, Object> options = getMap(st, "options");
            if (options != null) {
                int poolMax = getInt(options, "connection-pool-max-total");
                if (poolMax > 0) {
                    lines.add(prefix + ".jdbc.connection_pool.max_total=" + poolMax);
                }
                int metaCache = getInt(options, "metadata-cache-expiration-secs");
                if (metaCache > 0) {
                    lines.add(prefix + ".metadata.cache_expiration_time_secs=" + metaCache);
                }
                String endpointOverride = getString(options, "endpoint-override");
                if (!endpointOverride.isEmpty()) {
                    lines.add(prefix + ".dynamo.endpoint_override=" + endpointOverride);
                }
                String namespacePrefix = getString(options, "namespace-prefix");
                if (!namespacePrefix.isEmpty()) {
                    lines.add(prefix + ".dynamo.namespace.prefix=" + namespacePrefix);
                }
            }
            lines.add("");
        }

        // Namespace mapping
        if (storageNames.size() > 1) {
            List<String> mappings = new ArrayList<>();

            String coordStorage = defaultStorage;
            if (coordStorage.isEmpty() && !storageNames.isEmpty()) {
                coordStorage = storageNames.get(0);
            }
            mappings.add("coordinator:" + coordStorage);

            for (String nsName : sortedKeys(namespaces)) {
                Map<String, Object> ns = getMap(namespaces, nsName);
                mappings.add(nsName + ":" + getString(ns, "storage"));
            }

            lines.add("# Namespace Mapping");
            lines.add("scalar.db.multi_storage.namespace_mapping=" + String.join(",", mappings));
            lines.add("scalar.db.multi_storage.default_storage=" + coordStorage);
        }

        return String.join("\n", lines);
    }

    /**
     * Human-readable summary of the actual connection target, shown in verify/status results.
     * Pass the storage <b>after</b> placeholder resolution. Displayed in the UI to make visible
     * what was attempted, and to expose the effective value when an env var silently overrides
     * the value shown in the UI.
     */
    public String connectionTarget(Map<String, Object> st) {
        String type = getString(st, "type");
        if (type.equals("dynamo")) {
            String region = getString(st, "region");
            String ep = getString(getMap(st, "options"), "endpoint-override");
            String base = "dynamo region=" + (region.isEmpty() ? "(default)" : region);
            return ep.isEmpty() ? base : base + " endpoint=" + ep;
        }
        String cp = buildContactPoints(st);
        return cp.isEmpty() ? "(no contact point)" : cp;
    }

    /**
     * ScalarDB properties for a single storage (minimal setup without multi-storage).
     * Used for per-storage verify — builds an admin for just that storage to check connectivity.
     * connection-params are also included in contact_points via {@link #buildContactPoints}.
     */
    public String singleStorageProperties(Map<String, Object> st) {
        List<String> lines = new ArrayList<>();
        String storageType = getString(st, "type");
        lines.add("scalar.db.storage=" + storageType);
        lines.add("scalar.db.transaction_manager=consensus-commit");
        lines.add("scalar.db.contact_points=" + buildContactPoints(st));
        lines.add("scalar.db.username=" + getUsername(st));
        lines.add("scalar.db.password=" + getPassword(st));
        lines.add("scalar.db.cross_partition_scan.enabled=true");
        if (storageType.equals("jdbc")) {
            lines.add("scalar.db.cross_partition_scan.filtering.enabled=true");
            lines.add("scalar.db.cross_partition_scan.ordering.enabled=true");
        }
        Map<String, Object> options = getMap(st, "options");
        if (options != null) {
            String endpointOverride = getString(options, "endpoint-override");
            if (!endpointOverride.isEmpty()) {
                lines.add("scalar.db.dynamo.endpoint_override=" + endpointOverride);
            }
            String namespacePrefix = getString(options, "namespace-prefix");
            if (!namespacePrefix.isEmpty()) {
                lines.add("scalar.db.dynamo.namespace.prefix=" + namespacePrefix);
            }
        }
        return String.join("\n", lines);
    }

    /**
     * Builds a JDBC URL from driver/host/port/database. If contact-points is set, it takes
     * precedence (legacy/import compatibility). For dynamo, returns the region.
     *
     * <p>For JDBC drivers, {@code options.connection-params} (a raw string) is appended to
     * the end of the URL. The separator follows the driver's notation: {@code ;param;param}
     * for sqlserver, {@code ?param&param} for the others (mysql/postgresql/oracle).
     * Example: {@code sslMode=REQUIRED} enables a TLS connection on mysql (the equivalent of
     * SQL Server's {@code encrypt=true;trustServerCertificate=true}).
     * Not appended for legacy contact-points or dynamo (with the former, the operator can
     * write params directly into the URL). This is an addition in the Java version, not
     * present in the Go prototype.
     */
    private String buildContactPoints(Map<String, Object> st) {
        String cp = getString(st, "contact-points");
        if (!cp.isEmpty()) {
            return cp;
        }

        String storageType = getString(st, "type");
        if (storageType.equals("dynamo")) {
            return getString(st, "region");
        }

        String driver = getString(st, "driver");
        String host = getString(st, "host");
        int port = getInt(st, "port");
        String database = getString(st, "database");

        if (host.isEmpty()) {
            return "";
        }

        String url;
        switch (driver) {
            case "postgresql":
                if (port == 0) {
                    port = 5432;
                }
                url = database.isEmpty()
                        ? String.format("jdbc:postgresql://%s:%d/", host, port)
                        : String.format("jdbc:postgresql://%s:%d/%s", host, port, database);
                break;
            case "oracle":
                if (port == 0) {
                    port = 1521;
                }
                url = database.isEmpty()
                        ? String.format("jdbc:oracle:thin:@%s:%d", host, port)
                        : String.format("jdbc:oracle:thin:@%s:%d/%s", host, port, database);
                break;
            case "sqlserver":
                if (port == 0) {
                    port = 1433;
                }
                url = String.format("jdbc:sqlserver://%s:%d", host, port);
                if (!database.isEmpty()) {
                    url += String.format(";databaseName=%s", database);
                }
                break;
            default: // mysql
                if (port == 0) {
                    port = 3306;
                }
                url = String.format("jdbc:mysql://%s:%d/", host, port);
                break;
        }

        // Append connection-params (';' for sqlserver, '?' otherwise)
        Map<String, Object> options = getMap(st, "options");
        String params = options == null ? "" : getString(options, "connection-params").trim();
        if (!params.isEmpty()) {
            url += (driver.equals("sqlserver") ? ";" : "?") + params;
        }
        return url;
    }

    private String getUsername(Map<String, Object> st) {
        if (getString(st, "type").equals("dynamo")) {
            String v = getString(st, "access-key-id");
            if (!v.isEmpty()) {
                return v;
            }
        }
        return getString(st, "username");
    }

    private String getPassword(Map<String, Object> st) {
        if (getString(st, "type").equals("dynamo")) {
            String v = getString(st, "secret-access-key");
            if (!v.isEmpty()) {
                return v;
            }
        }
        return getString(st, "password");
    }

    // ---------------------------------------------------------------------
    // save : YAML output (clean normalization)
    // ---------------------------------------------------------------------

    public void saveYaml(String path, Map<String, Object> config) throws IOException {
        Map<String, Object> ordered = orderTopLevel(config);
        String out = new Yaml(dumperOptions()).dump(ordered);
        Files.writeString(Path.of(path), out, StandardCharsets.UTF_8);
    }

    private static DumperOptions dumperOptions() {
        DumperOptions opts = new DumperOptions();
        opts.setDefaultFlowStyle(DumperOptions.FlowStyle.BLOCK); // block style (empty maps become {})
        opts.setIndent(4);                                       // 4 spaces, same as the golden files
        opts.setWidth(Integer.MAX_VALUE);                        // never wrap long values (same as Go)
        opts.setSplitLines(false);
        return opts;
    }

    /**
     * Orders top-level keys in the fixed order [schema-version, global, scalardb, storages,
     * namespaces] followed by any remaining keys in ascending order, and returns a
     * LinkedHashMap tree with every nested map normalized to ascending key order.
     * SnakeYAML preserves LinkedHashMap insertion order, so this becomes the output order.
     */
    private Map<String, Object> orderTopLevel(Map<String, Object> config) {
        LinkedHashMap<String, Object> root = new LinkedHashMap<>();
        for (String key : TOP_LEVEL_KEYS) {
            if (config.containsKey(key)) {
                root.put(key, sortNested(config.get(key)));
            }
        }
        for (String key : sortedKeys(config)) {
            if (TOP_LEVEL_KEYS.contains(key)) {
                continue;
            }
            root.put(key, sortNested(config.get(key)));
        }
        return root;
    }

    @SuppressWarnings("unchecked")
    private Object sortNested(Object v) {
        if (v instanceof Map) {
            Map<String, Object> m = (Map<String, Object>) v;
            LinkedHashMap<String, Object> out = new LinkedHashMap<>();
            for (String k : sortedKeys(m)) {
                out.put(k, sortNested(m.get(k)));
            }
            return out;
        }
        if (v instanceof List) {
            List<Object> l = (List<Object>) v;
            List<Object> out = new ArrayList<>(l.size());
            for (Object e : l) {
                out.add(sortNested(e));
            }
            return out;
        }
        return v;
    }

    // ---------------------------------------------------------------------
    // load : YAML read + legacy migration
    // ---------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    public Map<String, Object> loadYaml(String path) throws IOException {
        String data = Files.readString(Path.of(path), StandardCharsets.UTF_8);
        Object parsed = new Yaml().load(data);
        Map<String, Object> config =
                parsed instanceof Map ? (Map<String, Object>) parsed : new LinkedHashMap<>();
        migrateStorages(config);
        return config;
    }

    /** Migrates legacy contact-points/username/password to the new format (ported from Go). */
    @SuppressWarnings("unchecked")
    private void migrateStorages(Map<String, Object> config) {
        Map<String, Object> storages = getMap(config, "storages");
        if (storages == null) {
            return;
        }

        for (Map.Entry<String, Object> e : storages.entrySet()) {
            if (!(e.getValue() instanceof Map)) {
                continue;
            }
            Map<String, Object> st = (Map<String, Object>) e.getValue();

            String storageType = getString(st, "type");
            String cp = getString(st, "contact-points");

            if (storageType.equals("dynamo") && !cp.isEmpty()) {
                // contact-points -> region, username -> access-key-id, password -> secret-access-key
                if (getString(st, "region").isEmpty()) {
                    st.put("region", cp);
                }
                if (getString(st, "access-key-id").isEmpty()) {
                    st.put("access-key-id", getString(st, "username"));
                }
                if (getString(st, "secret-access-key").isEmpty()) {
                    st.put("secret-access-key", getString(st, "password"));
                }
                st.remove("contact-points");
                st.remove("username");
                st.remove("password");
            } else if (storageType.equals("jdbc") && !cp.isEmpty()) {
                // parse JDBC URL into host/port/database/driver
                if (getString(st, "host").isEmpty()) {
                    JdbcUrl parsed = parseJdbcUrl(cp);
                    if (!parsed.driver.isEmpty()) {
                        st.put("driver", parsed.driver);
                    }
                    if (!parsed.host.isEmpty()) {
                        st.put("host", parsed.host);
                    }
                    if (parsed.port > 0) {
                        st.put("port", parsed.port);
                    }
                    if (!parsed.database.isEmpty()) {
                        st.put("database", parsed.database);
                    }
                }
                st.remove("contact-points");
            }
        }
    }

    private record JdbcUrl(String driver, String host, int port, String database) {}

    /** Extracts driver/host/port/database from a JDBC URL (ported from Go). */
    private JdbcUrl parseJdbcUrl(String url) {
        String driver;
        if (url.startsWith("jdbc:mysql://")) {
            driver = "mysql";
            url = url.substring("jdbc:mysql://".length());
        } else if (url.startsWith("jdbc:postgresql://")) {
            driver = "postgresql";
            url = url.substring("jdbc:postgresql://".length());
        } else if (url.startsWith("jdbc:oracle:thin:@")) {
            driver = "oracle";
            url = url.substring("jdbc:oracle:thin:@".length());
        } else if (url.startsWith("jdbc:sqlserver://")) {
            driver = "sqlserver";
            url = url.substring("jdbc:sqlserver://".length());
        } else {
            return new JdbcUrl("", "", 0, "");
        }

        // Remove trailing slash
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }

        // Split host:port/database
        String hostPort = url;
        String database = "";
        int slash = url.indexOf('/');
        if (slash >= 0) {
            hostPort = url.substring(0, slash);
            database = url.substring(slash + 1);
        }

        // Split host:port
        String host;
        int port = 0;
        int colonIdx = hostPort.lastIndexOf(':');
        if (colonIdx >= 0) {
            host = hostPort.substring(0, colonIdx);
            try {
                port = Integer.parseInt(hostPort.substring(colonIdx + 1));
            } catch (NumberFormatException ignored) {
                port = 0;
            }
        } else {
            host = hostPort;
        }

        return new JdbcUrl(driver, host, port, database);
    }

    // ---------------------------------------------------------------------
    // import : unimplemented stub (Go parity)
    // ---------------------------------------------------------------------

    public Map<String, Object> importLegacy(String scalardbPath, String appYmlPath) {
        // TODO: Implement legacy import (also unimplemented in the Go version)
        throw new UnsupportedOperationException("Import not yet implemented");
    }
}
