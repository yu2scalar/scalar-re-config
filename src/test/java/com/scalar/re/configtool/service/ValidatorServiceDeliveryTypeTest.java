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

import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Delivery-type validation (ConfigTool). Pins that {@code ordered_atomic} is an accepted
 * delivery type alongside the existing set, and that an unknown type is still rejected.
 */
class ValidatorServiceDeliveryTypeTest {

    private final ValidatorService validator = new ValidatorService();

    /** Minimal config with a single event type of the given delivery type. */
    private static Map<String, Object> configWithDeliveryType(String deliveryType) {
        Map<String, Object> et = new LinkedHashMap<>();
        et.put("delivery-type", deliveryType);
        et.put("partition-count", 2);
        Map<String, Object> ns = new LinkedHashMap<>();
        ns.put("storage", "pg");
        ns.put("event-types", new LinkedHashMap<>(Map.of("Evt", et)));
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("namespaces", new LinkedHashMap<>(Map.of("ns", ns)));
        return config;
    }

    private boolean hasDeliveryTypeError(String deliveryType) {
        return validator.validate(configWithDeliveryType(deliveryType)).errors().stream()
                .map(ValidationError::path)
                .anyMatch(p -> p.endsWith(".delivery-type"));
    }

    @Test
    void orderedAtomicAccepted() {
        assertThat(hasDeliveryTypeError("ordered_atomic"))
                .as("ordered_atomic must be an accepted delivery type")
                .isFalse();
    }

    @Test
    void existingTypesAccepted() {
        for (String t : new String[] {"atomic", "partial", "relay", "pull", "qpull", "spull"}) {
            assertThat(hasDeliveryTypeError(t)).as(t + " must be accepted").isFalse();
        }
    }

    @Test
    void unknownTypeRejected() {
        assertThat(hasDeliveryTypeError("ordered"))   // bare 'ordered' is NOT a valid type (D8)
                .as("an unknown delivery type must be rejected")
                .isTrue();
        assertThat(hasDeliveryTypeError("bogus")).isTrue();
    }
}
