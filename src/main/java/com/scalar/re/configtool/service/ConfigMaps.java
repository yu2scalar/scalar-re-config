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

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Helpers for reading the {@code map[string]interface{}}-style config tree with the same
 * semantics as the Go version. A port consolidating in one place the getMap / getString /
 * getInt / sortedKeys / contains helpers that existed in both the Go generator.go and
 * validator.go.
 *
 * <p>Semantics are faithful to Go:
 * <ul>
 *   <li>{@code getString} — strings as-is, anything else via {@code String.valueOf}
 *       (equivalent to Go's {@code fmt.Sprintf("%v", v)}). Missing/nil is an empty string.</li>
 *   <li>{@code getInt} — intValue for Numbers, 0 for anything else (e.g. placeholder strings).
 *       Thus a placeholder port becomes 0 and falls back to the default port
 *       (important behavior that reproduces e.g. {@code :3306/} in the golden files).</li>
 *   <li>{@code sortedKeys} — ascending key order (equivalent to Go's sort.Strings).</li>
 * </ul>
 */
final class ConfigMaps {

    private ConfigMaps() {}

    @SuppressWarnings("unchecked")
    static Map<String, Object> getMap(Map<String, Object> m, String key) {
        if (m == null) {
            return null;
        }
        Object v = m.get(key);
        if (v instanceof Map) {
            return (Map<String, Object>) v;
        }
        return null;
    }

    static String getString(Map<String, Object> m, String key) {
        if (m == null) {
            return "";
        }
        Object v = m.get(key);
        if (v == null) {
            return "";
        }
        if (v instanceof String s) {
            return s;
        }
        return String.valueOf(v);
    }

    static int getInt(Map<String, Object> m, String key) {
        if (m == null) {
            return 0;
        }
        Object v = m.get(key);
        if (v instanceof Number n) {
            return n.intValue();
        }
        return 0;
    }

    static List<String> sortedKeys(Map<String, Object> m) {
        List<String> keys = new ArrayList<>();
        if (m != null) {
            keys.addAll(m.keySet());
        }
        Collections.sort(keys);
        return keys;
    }

    static boolean contains(List<String> slice, String item) {
        return slice.contains(item);
    }
}
