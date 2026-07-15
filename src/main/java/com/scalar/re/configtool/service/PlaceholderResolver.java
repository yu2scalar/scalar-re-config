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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Resolves {@code ${VAR:default}} placeholders in the config, shell-style.
 *
 * <p>Semantics: if {@code System.getenv(VAR)} is non-null, use that value;
 * otherwise use the default after the {@code :} (empty string if there is no {@code :}).
 *
 * <p>Used <b>only on the verify path</b>: expands the config to real values before passing it
 * to {@code toScalarDbProperties}, preventing {@code ${...}} literals (which ScalarDB does not
 * resolve) from breaking the JDBC URL. Preview / save output keeps the placeholders as before
 * (golden files unchanged).
 *
 * <p>Defaults may contain colons (e.g. {@code ${VAR:http://dynamodb:8000}}): the VAR name runs
 * up to the first {@code :}, and the default from there to the closing {@code }}. All
 * occurrences within a string value, including multiple or partial ones, are replaced.
 */
@Service
public class PlaceholderResolver {

    // ${ VAR (no colon or '}') ( : default (no '}') )? }
    private static final Pattern PLACEHOLDER = Pattern.compile("\\$\\{([^}:]+)(?::([^}]*))?}");

    /** Recursively walks the config tree (Map/List/scalar) and returns a new tree with placeholders in string values resolved. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> resolve(Map<String, Object> config) {
        return (Map<String, Object>) resolveValue(config);
    }

    @SuppressWarnings("unchecked")
    private Object resolveValue(Object v) {
        if (v instanceof Map) {
            Map<String, Object> m = (Map<String, Object>) v;
            LinkedHashMap<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : m.entrySet()) {
                out.put(e.getKey(), resolveValue(e.getValue()));
            }
            return out;
        }
        if (v instanceof List) {
            List<Object> l = (List<Object>) v;
            List<Object> out = new ArrayList<>(l.size());
            for (Object e : l) {
                out.add(resolveValue(e));
            }
            return out;
        }
        if (v instanceof String s) {
            return resolveString(s);
        }
        return v;
    }

    /** Resolves all {@code ${VAR:default}} occurrences within a single string. */
    String resolveString(String s) {
        Matcher m = PLACEHOLDER.matcher(s);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            String var = m.group(1);
            String def = m.group(2); // null = no colon
            String env = System.getenv(var);
            String value = env != null ? env : (def != null ? def : "");
            m.appendReplacement(sb, Matcher.quoteReplacement(value));
        }
        m.appendTail(sb);
        return sb.toString();
    }
}
