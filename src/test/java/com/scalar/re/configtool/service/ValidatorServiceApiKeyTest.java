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

import com.scalar.re.configtool.model.ValidationError;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@code global.auth.api-key} is required (RE 0.9.6+ refuses to start without it): a missing or
 * blank key is a validation error; any value, the sample {@code change-me} and an
 * {@code ${ENV:default}} placeholder included, is accepted.
 */
class ValidatorServiceApiKeyTest {

    private final ValidatorService validator = new ValidatorService();

    private static Map<String, Object> configWithGlobal(Map<String, Object> global) {
        Map<String, Object> config = new LinkedHashMap<>();
        if (global != null) {
            config.put("global", global);
        }
        return config;
    }

    private static Map<String, Object> globalWithAuth(Map<String, Object> auth) {
        Map<String, Object> global = new LinkedHashMap<>();
        if (auth != null) {
            global.put("auth", auth);
        }
        return global;
    }

    private static Map<String, Object> authWithKey(Object key) {
        Map<String, Object> auth = new HashMap<>(); // allows a null value
        auth.put("api-key", key);
        return auth;
    }

    private boolean apiKeyError(Map<String, Object> config) {
        return validator.validate(config).errors().stream()
                .map(ValidationError::path)
                .anyMatch("global.auth.api-key"::equals);
    }

    @Test
    void noGlobal_error() {
        assertThat(apiKeyError(configWithGlobal(null))).isTrue();
    }

    @Test
    void noAuthSection_error() {
        assertThat(apiKeyError(configWithGlobal(globalWithAuth(null)))).isTrue();
    }

    @Test
    void authWithoutKey_error() {
        assertThat(apiKeyError(configWithGlobal(globalWithAuth(new LinkedHashMap<>())))).isTrue();
    }

    @Test
    void nullKey_error() {
        assertThat(apiKeyError(configWithGlobal(globalWithAuth(authWithKey(null))))).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"", " ", "\t"})
    void blankKey_error(String key) {
        assertThat(apiKeyError(configWithGlobal(globalWithAuth(authWithKey(key))))).isTrue();
    }

    @Test
    void errorIsReportedAsAnError_withAMessage() {
        ValidationError e = validator.validate(configWithGlobal(null)).errors().stream()
                .filter(x -> x.path().equals("global.auth.api-key")).findFirst().orElseThrow();
        assertThat(e.level()).isEqualTo("error");
        assertThat(e.message()).contains("required");
    }

    @ParameterizedTest
    @ValueSource(strings = {"k", "change-me", "${SCALAR_RE_API_KEY:change-me}", "${SCALAR_RE_API_KEY}"})
    void anyKey_accepted(String key) {
        assertThat(apiKeyError(configWithGlobal(globalWithAuth(authWithKey(key))))).isFalse();
    }
}
