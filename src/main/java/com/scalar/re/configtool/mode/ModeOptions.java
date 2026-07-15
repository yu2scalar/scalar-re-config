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

package com.scalar.re.configtool.mode;

/**
 * Run mode and options resolved from the launch arguments.
 *
 * <pre>
 *   java -jar config-tool.jar --mode=serve                                   # UI (default)
 *   java -jar config-tool.jar --mode=init --config=/conf/scalar-re-config.yml [--verify-only]
 * </pre>
 *
 * <p>Only {@code --mode} / {@code --config} / {@code --verify-only} are interpreted;
 * all other arguments (Spring's {@code --server.port=} etc.) are ignored and passed through.
 *
 * @param mode           run mode (default SERVE)
 * @param configPath     config file path read in init mode (unused in serve)
 * @param verifyOnly     in init mode, stop after verify and skip init (schema creation)
 * @param recreateSchema in init mode, perform destructive recreate (drop then create); explicit opt-in
 */
public record ModeOptions(Mode mode, String configPath, boolean verifyOnly, boolean recreateSchema) {

    public enum Mode {
        SERVE,
        INIT
    }

    private static final String MODE_PREFIX = "--mode=";
    private static final String CONFIG_PREFIX = "--config=";
    private static final String VERIFY_ONLY_FLAG = "--verify-only";
    private static final String RECREATE_FLAG = "--recreate-schema";

    /**
     * Parses the argument list. An unknown {@code --mode} value throws
     * {@link IllegalArgumentException} (the caller is expected to convert it into
     * a usage error = exit 2).
     */
    public static ModeOptions parse(String[] args) {
        Mode mode = Mode.SERVE;
        String configPath = null;
        boolean verifyOnly = false;
        boolean recreateSchema = false;

        for (String a : args) {
            if (a.equals(VERIFY_ONLY_FLAG)) {
                verifyOnly = true;
            } else if (a.equals(RECREATE_FLAG)) {
                recreateSchema = true;
            } else if (a.startsWith(MODE_PREFIX)) {
                String v = a.substring(MODE_PREFIX.length()).trim().toLowerCase();
                mode = switch (v) {
                    case "init" -> Mode.INIT;
                    case "serve" -> Mode.SERVE;
                    default -> throw new IllegalArgumentException(
                            "Unknown --mode: " + v + " (expected serve|init)");
                };
            } else if (a.startsWith(CONFIG_PREFIX)) {
                configPath = a.substring(CONFIG_PREFIX.length());
            }
            // Everything else (--server.port= etc.) is ignored
        }

        return new ModeOptions(mode, configPath, verifyOnly, recreateSchema);
    }
}
