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

import static com.scalar.re.configtool.service.ConfigMaps.contains;
import static com.scalar.re.configtool.service.ConfigMaps.getInt;
import static com.scalar.re.configtool.service.ConfigMaps.getMap;
import static com.scalar.re.configtool.service.ConfigMaps.getString;

import com.scalar.re.configtool.model.ValidationError;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Validation of the unified config. A faithful port of the original Go prototype's
 * {@code internal/validator/validator.go}.
 *
 * <p>Three levels: Level 1 (syntax) / Level 2 (consistency) / Level 3 (deprecation warnings).
 *
 * <p>Important Go-compatibility note: the shared-HMAC-key warning and the DynamoDB region
 * format warning carry {@code level="warning"} yet <b>end up in the errors list</b>
 * (the Go side does {@code errors = append(errors, ...)}). Consequently, under the
 * {@code valid = errors.isEmpty()} check they make valid false.
 * The {@code warnings} list contains only deprecation warnings.
 * This behavior is preserved intentionally.
 */
@Service
public class ValidatorService {

    private static final Pattern NAME_PATTERN = Pattern.compile("^[a-z][a-z0-9_]*$");
    private static final Pattern HOST_PATTERN = Pattern.compile("^[a-zA-Z0-9._-]+$");
    private static final Pattern REGION_PATTERN = Pattern.compile("^[a-z]{2}-[a-z]+-\\d+$");
    private static final Pattern ENV_PLACEHOLDER_PATTERN = Pattern.compile("^\\$\\{[^}]+\\}$");

    /** Validation result. {@code errors} / {@code warnings} correspond to the two Go return values. */
    public record Result(List<ValidationError> errors, List<ValidationError> warnings) {}

    public Result validate(Map<String, Object> config) {
        Map<String, Object> storages = getMap(config, "storages");
        Map<String, Object> namespaces = getMap(config, "namespaces");
        Map<String, Object> global = getMap(config, "global");
        Map<String, Object> scalardb = getMap(config, "scalardb");

        List<ValidationError> errors = new ArrayList<>();
        // Level 1: Syntax validation
        errors.addAll(validateStorageSyntax(storages));
        errors.addAll(validateNamespaceSyntax(namespaces));
        errors.addAll(validateScalarDbSyntax(scalardb, storages));
        // Level 2: Consistency validation
        errors.addAll(validateConsistency(storages, namespaces, global));

        // Level 3: Deprecation warnings
        List<ValidationError> warnings = new ArrayList<>(validateDeprecations(global));

        return new Result(errors, warnings);
    }

    private List<ValidationError> validateStorageSyntax(Map<String, Object> storages) {
        List<ValidationError> errors = new ArrayList<>();
        if (storages == null) {
            errors.add(new ValidationError("error", "storages", "At least one storage must be defined"));
            return errors;
        }

        for (Map.Entry<String, Object> e : storages.entrySet()) {
            String name = e.getKey();
            if (!NAME_PATTERN.matcher(name).matches()) {
                errors.add(new ValidationError("error", "storages." + name,
                        "Storage name must be lowercase letters, digits, and underscores"));
            }

            if (!(e.getValue() instanceof Map)) {
                continue;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> st = (Map<String, Object>) e.getValue();

            String storageType = getString(st, "type");
            if (storageType.isEmpty()) {
                errors.add(new ValidationError("error", "storages." + name + ".type",
                        "Storage type is required"));
            } else if (!storageType.equals("jdbc") && !storageType.equals("dynamo")
                    && !storageType.equals("cosmos")) {
                errors.add(new ValidationError("error", "storages." + name + ".type",
                        "Invalid storage type: " + storageType + " (must be jdbc, dynamo, or cosmos)"));
            }

            if (storageType.equals("jdbc")) {
                // contact-points is legacy; new format uses host/port/driver
                if (getString(st, "contact-points").isEmpty()) {
                    String host = getString(st, "host");
                    if (host.isEmpty()) {
                        errors.add(new ValidationError("error", "storages." + name + ".host",
                                "Host is required"));
                    } else if (!ENV_PLACEHOLDER_PATTERN.matcher(host).matches()
                            && !HOST_PATTERN.matcher(host).matches()) {
                        errors.add(new ValidationError("error", "storages." + name + ".host",
                                "Invalid host format"));
                    }

                    String portStr = getString(st, "port");
                    if (!ENV_PLACEHOLDER_PATTERN.matcher(portStr).matches()) {
                        int port = getInt(st, "port");
                        if (port < 0 || port > 65535) {
                            errors.add(new ValidationError("error", "storages." + name + ".port",
                                    "Port must be between 1 and 65535"));
                        }
                    }

                    String driver = getString(st, "driver");
                    String database = getString(st, "database");
                    if (driver.equals("postgresql") && database.isEmpty()) {
                        errors.add(new ValidationError("error", "storages." + name + ".database",
                                "Database is required for PostgreSQL"));
                    }
                }
            } else if (storageType.equals("dynamo")) {
                if (getString(st, "contact-points").isEmpty()) {
                    String region = getString(st, "region");
                    Map<String, Object> options = getMap(st, "options");
                    boolean hasEndpointOverride =
                            options != null && !getString(options, "endpoint-override").isEmpty();
                    if (region.isEmpty()) {
                        errors.add(new ValidationError("error", "storages." + name + ".region",
                                "Region is required for DynamoDB"));
                    } else if (!ENV_PLACEHOLDER_PATTERN.matcher(region).matches()
                            && !hasEndpointOverride && !REGION_PATTERN.matcher(region).matches()) {
                        // Skip format check for env placeholders and DynamoDB Local (endpoint-override)
                        errors.add(new ValidationError("warning", "storages." + name + ".region",
                                "Region '" + region + "' does not match expected format (e.g. ap-northeast-1)"));
                    }
                }
            }
        }
        return errors;
    }

    private List<ValidationError> validateNamespaceSyntax(Map<String, Object> namespaces) {
        List<ValidationError> errors = new ArrayList<>();
        if (namespaces == null) {
            errors.add(new ValidationError("error", "namespaces", "At least one namespace must be defined"));
            return errors;
        }

        List<String> validTypes =
                List.of("atomic", "partial", "relay", "pull", "qpull", "spull", "ordered_atomic");

        for (Map.Entry<String, Object> e : namespaces.entrySet()) {
            String name = e.getKey();
            if (!NAME_PATTERN.matcher(name).matches()) {
                errors.add(new ValidationError("error", "namespaces." + name,
                        "Namespace name must be lowercase letters, digits, and underscores"));
            }

            if (!(e.getValue() instanceof Map)) {
                continue;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> ns = (Map<String, Object>) e.getValue();

            if (getString(ns, "storage").isEmpty()) {
                errors.add(new ValidationError("error", "namespaces." + name + ".storage",
                        "Storage reference is required"));
            }

            Map<String, Object> eventTypes = getMap(ns, "event-types");
            if (eventTypes != null) {
                for (Map.Entry<String, Object> ete : eventTypes.entrySet()) {
                    String etName = ete.getKey();
                    if (!(ete.getValue() instanceof Map)) {
                        continue;
                    }
                    @SuppressWarnings("unchecked")
                    Map<String, Object> et = (Map<String, Object>) ete.getValue();
                    String deliveryType = getString(et, "delivery-type");
                    if (!deliveryType.isEmpty() && !contains(validTypes, deliveryType)) {
                        errors.add(new ValidationError("error",
                                "namespaces." + name + ".event-types." + etName + ".delivery-type",
                                "Invalid delivery type: " + deliveryType + " (must be one of: "
                                        + String.join(", ", validTypes) + ")"));
                    }
                    if (deliveryType.equals("pull") && getString(et, "destination").isEmpty()) {
                        errors.add(new ValidationError("error",
                                "namespaces." + name + ".event-types." + etName + ".destination",
                                "Destination is required for delivery type: " + deliveryType));
                    }
                }
            }
        }
        return errors;
    }

    private List<ValidationError> validateScalarDbSyntax(
            Map<String, Object> scalardb, Map<String, Object> storages) {
        List<ValidationError> errors = new ArrayList<>();
        if (scalardb == null) {
            return errors;
        }

        String defaultStorage = getString(scalardb, "default-storage");
        if (defaultStorage.isEmpty() && storages != null && !storages.isEmpty()) {
            errors.add(new ValidationError("error", "scalardb.default-storage",
                    "Default storage is required"));
        } else if (!defaultStorage.isEmpty() && storages != null) {
            if (!storages.containsKey(defaultStorage)) {
                errors.add(new ValidationError("error", "scalardb.default-storage",
                        "Default storage '" + defaultStorage + "' is not defined in storages section"));
            }
        }

        String isolationLevel = getString(scalardb, "isolation-level");
        if (!isolationLevel.isEmpty()) {
            List<String> validLevels = List.of("SNAPSHOT", "READ_COMMITTED", "SERIALIZABLE");
            if (!contains(validLevels, isolationLevel)) {
                errors.add(new ValidationError("error", "scalardb.isolation-level",
                        "Invalid isolation level: " + isolationLevel + " (must be one of: "
                                + String.join(", ", validLevels) + ")"));
            }
        }

        return errors;
    }

    private List<ValidationError> validateConsistency(
            Map<String, Object> storages, Map<String, Object> namespaces, Map<String, Object> global) {
        List<ValidationError> errors = new ArrayList<>();

        java.util.Set<String> storageNames = storages == null ? java.util.Set.of() : storages.keySet();
        java.util.Set<String> namespaceNames = namespaces == null ? java.util.Set.of() : namespaces.keySet();

        if (namespaces != null) {
            for (Map.Entry<String, Object> e : namespaces.entrySet()) {
                String nsName = e.getKey();
                if (!(e.getValue() instanceof Map)) {
                    continue;
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> ns = (Map<String, Object>) e.getValue();

                String storage = getString(ns, "storage");
                if (!storage.isEmpty() && !storageNames.contains(storage)) {
                    errors.add(new ValidationError("error", "namespaces." + nsName + ".storage",
                            "Storage '" + storage + "' is not defined in storages section"));
                }

                Map<String, Object> eventTypes = getMap(ns, "event-types");
                if (eventTypes != null) {
                    for (Map.Entry<String, Object> ete : eventTypes.entrySet()) {
                        String etName = ete.getKey();
                        if (!(ete.getValue() instanceof Map)) {
                            continue;
                        }
                        @SuppressWarnings("unchecked")
                        Map<String, Object> et = (Map<String, Object>) ete.getValue();
                        String dest = getString(et, "destination");
                        if (!dest.isEmpty() && !namespaceNames.contains(dest)) {
                            errors.add(new ValidationError("error",
                                    "namespaces." + nsName + ".event-types." + etName + ".destination",
                                    "Destination namespace '" + dest + "' is not defined"));
                        }
                    }
                }
            }
        }

        // global.re-tables: each required table must reference an existing namespace
        if (global != null) {
            Map<String, Object> reTables = getMap(global, "re-tables");
            List<String> requiredTables =
                    List.of("re_node_heartbeat", "re_completed", "re_queue", "re_subscription");
            for (String tableName : requiredTables) {
                Map<String, Object> table = getMap(reTables, tableName);
                if (table == null) {
                    errors.add(new ValidationError("error", "global.re-tables." + tableName,
                            "Management table configuration is required"));
                    continue;
                }
                String ns = getString(table, "namespace");
                if (ns.isEmpty()) {
                    errors.add(new ValidationError("error", "global.re-tables." + tableName + ".namespace",
                            "Namespace is required for management table"));
                } else if (!namespaceNames.contains(ns)) {
                    errors.add(new ValidationError("error", "global.re-tables." + tableName + ".namespace",
                            "Namespace '" + ns + "' is not defined in namespaces section"));
                }
            }
        }

        // Warn (in errors list, per Go) if all namespaces share the same effective HMAC key.
        if (namespaces != null && namespaces.size() > 1) {
            java.util.Set<String> effKeys = new java.util.HashSet<>();
            boolean allHaveKey = true;
            for (Object v : namespaces.values()) {
                if (!(v instanceof Map)) {
                    continue;
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> ns = (Map<String, Object>) v;
                String k = getString(getMap(ns, "hmac"), "key");
                if (k.isEmpty()) {
                    allHaveKey = false;
                    break;
                }
                effKeys.add(hmacEffectiveKey(k));
            }
            if (allHaveKey && effKeys.size() == 1) {
                errors.add(new ValidationError("warning", "namespaces.*.hmac.key",
                        "All namespaces share the same HMAC key; keys must differ per namespace "
                                + "(a shared key masks destination-key resolution)"));
            }
        }

        return errors;
    }

    /**
     * Extracts the fallback default from a {@code ${VAR:default}} placeholder
     * (so that two namespaces differing only in env var name but sharing the same
     * fallback are treated as equal). Returns the value as-is if it is not a placeholder.
     */
    private static String hmacEffectiveKey(String k) {
        if (k.startsWith("${") && k.endsWith("}")) {
            String inner = k.substring(2, k.length() - 1);
            int idx = inner.indexOf(':');
            if (idx >= 0) {
                return inner.substring(idx + 1);
            }
        }
        return k;
    }

    private List<ValidationError> validateDeprecations(Map<String, Object> global) {
        List<ValidationError> warnings = new ArrayList<>();
        if (global == null) {
            return warnings;
        }
        if (global.containsKey("auto-create-tables")) {
            warnings.add(new ValidationError("warning", "global.auto-create-tables",
                    "Deprecated in v2.6: auto-create-tables is ignored at runtime. "
                            + "Use --create-schema via the init image instead"));
        }
        if (global.containsKey("drop-and-recreate-tables")) {
            warnings.add(new ValidationError("warning", "global.drop-and-recreate-tables",
                    "Deprecated in v2.6: drop-and-recreate-tables is ignored at runtime. "
                            + "Use --recreate-schema via the init image instead"));
        }
        if (global.containsKey("native-polling")) {
            warnings.add(new ValidationError("warning", "global.native-polling",
                    "Deprecated: native-polling has been removed and is ignored at runtime"));
        }
        return warnings;
    }
}
