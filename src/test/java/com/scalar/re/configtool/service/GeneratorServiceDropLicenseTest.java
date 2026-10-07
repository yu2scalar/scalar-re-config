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

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A license is not required (RE defaults max-nodes to 9999), so save never emits
 * {@code global.license}; an old config that has it still loads.
 */
class GeneratorServiceDropLicenseTest {

    private final GeneratorService generator = new GeneratorService();

    @TempDir
    Path dir;

    private static Map<String, Object> configWithGlobal(Map<String, Object> global) {
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("schema-version", "1.0");
        if (global != null) {
            config.put("global", global);
        }
        return config;
    }

    private String save(Map<String, Object> config) throws Exception {
        Path out = dir.resolve("out.yml");
        generator.saveYaml(out.toString(), config);
        return Files.readString(out);
    }

    @Test
    void licensePresent_droppedOnSave_inputUntouched() throws Exception {
        Map<String, Object> license = new LinkedHashMap<>(Map.of("max-nodes", 3, "expires-at", "2027-12-31"));
        Map<String, Object> global = new LinkedHashMap<>();
        global.put("license", license);
        global.put("completed-ttl-seconds", 0);
        Map<String, Object> config = configWithGlobal(global);

        String yaml = save(config);

        assertThat(yaml).doesNotContain("license").doesNotContain("max-nodes").contains("completed-ttl-seconds: 0");
        assertThat(global).containsKey("license");   // only the output copy is changed
    }

    @Test
    void licenseAbsent_otherGlobalKeysKept() throws Exception {
        Map<String, Object> global = new LinkedHashMap<>(Map.of("completed-ttl-seconds", 0));
        assertThat(save(configWithGlobal(global))).doesNotContain("license").contains("completed-ttl-seconds: 0");
    }

    @Test
    void globalAbsent_saves() throws Exception {
        assertThat(save(configWithGlobal(null))).contains("schema-version").doesNotContain("global");
    }

    @Test
    void globalNotAMap_leftAsIs() throws Exception {
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("global", "x");
        assertThat(save(config)).contains("global: x");
    }

    @Test
    void oldConfigWithLicense_loads() throws Exception {
        Path in = dir.resolve("in.yml");
        Files.writeString(in, "global:\n  license:\n    max-nodes: 3\n");
        assertThat(generator.loadYaml(in.toString())).containsKey("global");
    }
}
