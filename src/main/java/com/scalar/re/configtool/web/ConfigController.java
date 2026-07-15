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

import com.fasterxml.jackson.annotation.JsonProperty;
import com.scalar.re.configtool.service.GeneratorService;
import com.scalar.re.configtool.service.ValidatorService;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Five endpoints (validate / preview / save / load / import).
 * Follows the handler contract of the Go version's {@code internal/server/router.go}.
 *
 * <p>The frontend {@code frontend/src/api.ts} calls these as-is (reused unmodified).
 * Request/response field names match the Go JSON tags.
 */
@RestController
@RequestMapping("/api")
public class ConfigController {

    private final GeneratorService generator;
    private final ValidatorService validator;

    public ConfigController(GeneratorService generator, ValidatorService validator) {
        this.generator = generator;
        this.validator = validator;
    }

    @PostMapping("/validate")
    public Map<String, Object> validate(@RequestBody Map<String, Object> config) {
        ValidatorService.Result result = validator.validate(config);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("valid", result.errors().isEmpty());
        resp.put("errors", result.errors());
        resp.put("warnings", result.warnings());
        return resp;
    }

    @PostMapping("/preview")
    public Map<String, Object> preview(@RequestBody Map<String, Object> config) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("scalardb_properties", generator.toScalarDbProperties(config));
        return resp;
    }

    @PostMapping("/save")
    public ResponseEntity<?> save(@RequestBody SaveRequest req) {
        try {
            generator.saveYaml(req.path(), req.config());
            Map<String, String> resp = new LinkedHashMap<>();
            resp.put("status", "ok");
            resp.put("path", req.path());
            return ResponseEntity.ok(resp);
        } catch (IOException e) {
            return ResponseEntity.status(500).body(e.getMessage());
        }
    }

    @PostMapping("/load")
    public ResponseEntity<?> load(@RequestBody LoadRequest req) {
        try {
            return ResponseEntity.ok(generator.loadYaml(req.path()));
        } catch (IOException e) {
            return ResponseEntity.status(500).body(e.getMessage());
        }
    }

    @PostMapping("/import")
    public ResponseEntity<?> importLegacy(@RequestBody ImportRequest req) {
        try {
            return ResponseEntity.ok(
                    generator.importLegacy(req.scalardbPropertiesPath(), req.applicationYmlPath()));
        } catch (UnsupportedOperationException e) {
            // Same as the Go version: 500 + plain-text body (the frontend throws res.text())
            return ResponseEntity.status(500).body(e.getMessage());
        }
    }

    // --- request DTOs (corresponding to the Go handlers' inline structs) ----------------------

    record SaveRequest(String path, Map<String, Object> config) {}

    record LoadRequest(String path) {}

    record ImportRequest(
            @JsonProperty("scalardb_properties_path") String scalardbPropertiesPath,
            @JsonProperty("application_yml_path") String applicationYmlPath) {}
}
