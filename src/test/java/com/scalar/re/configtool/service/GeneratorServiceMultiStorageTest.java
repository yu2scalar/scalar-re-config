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

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The generated ScalarDB properties are always multi-storage — also with a single storage, which
 * used to switch to single-storage mode while writing the connection under
 * scalar.db.multi_storage.storages.<name>.*, so the DB verify and schema init failed with an empty
 * contact_points (same fix as scalar-re backlog §2.49).
 */
class GeneratorServiceMultiStorageTest {

    private final GeneratorService generator = new GeneratorService();

    private static Map<String, Object> config(int storageCount) {
        Map<String, Object> storages = new LinkedHashMap<>();
        Map<String, Object> namespaces = new LinkedHashMap<>();
        for (int i = 0; i < storageCount; i++) {
            Map<String, Object> st = new LinkedHashMap<>();
            st.put("type", "jdbc");
            st.put("driver", "postgresql");
            st.put("host", "db" + i + ".example.com");
            st.put("port", 5432);
            st.put("username", "u");
            st.put("password", "p");
            storages.put("st" + i, st);
            namespaces.put("ns" + i + "_a", Map.of("storage", "st" + i));
            namespaces.put("ns" + i + "_b", Map.of("storage", "st" + i));
        }
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("storages", storages);
        config.put("namespaces", namespaces);
        return config;
    }

    private static Map<String, String> props(String text) {
        Map<String, String> out = new LinkedHashMap<>();
        Arrays.stream(text.split("\n"))
                .filter(l -> !l.isBlank() && !l.startsWith("#") && l.contains("="))
                .forEach(l -> out.put(l.substring(0, l.indexOf('=')), l.substring(l.indexOf('=') + 1)));
        return out;
    }

    @ParameterizedTest(name = "{0} storage(s) -> multi-storage")
    @ValueSource(ints = {1, 2, 3})
    void anyStorageCount_isMultiStorage(int count) {
        Map<String, String> p = props(generator.toScalarDbProperties(config(count)));

        assertThat(p.get("scalar.db.storage")).isEqualTo("multi-storage");
        assertThat(p.get("scalar.db.multi_storage.storages").split(",")).hasSize(count);
        assertThat(p).doesNotContainKey("scalar.db.contact_points");
        for (int i = 0; i < count; i++) {
            assertThat(p.get("scalar.db.multi_storage.storages.st" + i + ".contact_points"))
                    .contains("db" + i + ".example.com");
        }
        String mapping = p.get("scalar.db.multi_storage.namespace_mapping");
        assertThat(mapping).startsWith("coordinator:st0");
        for (int i = 0; i < count; i++) {
            assertThat(mapping).contains("ns" + i + "_a:st" + i).contains("ns" + i + "_b:st" + i);
        }
        assertThat(p.get("scalar.db.multi_storage.default_storage")).isEqualTo("st0");
    }

    @Test
    void noStorages_setsNoStorageMode() {
        Map<String, String> p = props(generator.toScalarDbProperties(config(0)));
        assertThat(p).doesNotContainKeys("scalar.db.storage", "scalar.db.multi_storage.storages",
                "scalar.db.multi_storage.namespace_mapping");
    }
}
