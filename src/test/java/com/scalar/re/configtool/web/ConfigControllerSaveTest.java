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

package com.scalar.re.configtool.web;

import com.scalar.re.configtool.service.GeneratorService;
import com.scalar.re.configtool.service.ValidatorService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@code POST /api/save} writes only a config without validation errors (2026-10-05: any
 * validation error stops the output — the screen disables its save buttons, the API refuses).
 */
class ConfigControllerSaveTest {

    private final GeneratorService generator = new GeneratorService();
    private final ValidatorService validator = new ValidatorService();
    private final ConfigController controller = new ConfigController(generator, validator);

    private Map<String, Object> sample() throws Exception {
        Map<String, Object> config = generator.loadYaml("samples/scalar-re-config.yml");
        assertThat(validator.validate(config).errors()).as("the sample is valid").isEmpty();
        return config;
    }

    @Test
    void validConfig_written_200(@TempDir Path dir) throws Exception {
        Path out = dir.resolve("out.yml");

        ResponseEntity<?> resp = controller.save(new ConfigController.SaveRequest(out.toString(), sample()));

        assertThat(resp.getStatusCode().value()).isEqualTo(200);
        assertThat(out).exists();
    }

    @Test
    @SuppressWarnings("unchecked")
    void oneValidationError_notWritten_400WithTheErrors(@TempDir Path dir) throws Exception {
        Map<String, Object> config = sample();
        ((Map<String, Object>) ((Map<String, Object>) config.get("global")).get("auth")).put("api-key", "");
        Path out = dir.resolve("out.yml");

        ResponseEntity<?> resp = controller.save(new ConfigController.SaveRequest(out.toString(), config));

        assertThat(resp.getStatusCode().value()).isEqualTo(400);
        Map<String, Object> body = (Map<String, Object>) resp.getBody();
        assertThat(body).containsEntry("status", "invalid");
        assertThat(body.get("errors").toString()).contains("global.auth.api-key");
        assertThat(Files.exists(out)).isFalse();
    }
}
