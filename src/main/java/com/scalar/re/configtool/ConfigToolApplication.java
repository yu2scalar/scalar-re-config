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

package com.scalar.re.configtool;

import com.scalar.re.configtool.mode.InitRunner;
import com.scalar.re.configtool.mode.ModeOptions;
import com.scalar.re.configtool.serve.TlsBootstrap;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * ScalarRE Config Tool — Spring Boot entry point.
 *
 * <p>Two launch modes:
 * <ul>
 *   <li><b>serve</b> (default) — web server that serves the React UI. The browser is
 *       auto-opened only when the bind is loopback
 *       ({@link com.scalar.re.configtool.serve.BrowserLauncher}).</li>
 *   <li><b>init</b> ({@code --mode=init --config=...}) — headless run without the web
 *       server: loads and validates the config, verifies/initializes the DB, and
 *       returns an exit code ({@link InitRunner}).</li>
 * </ul>
 */
@SpringBootApplication
public class ConfigToolApplication {

    public static void main(String[] args) {
        ModeOptions opts;
        try {
            opts = ModeOptions.parse(args);
        } catch (IllegalArgumentException e) {
            System.err.println("[config-tool] " + e.getMessage());
            System.exit(2);
            return;
        }

        if (opts.mode() == ModeOptions.Mode.INIT) {
            // Headless: run init without starting Spring/web and return the exit code
            System.exit(InitRunner.run(opts));
            return;
        }

        // serve (default): resolve TLS (HTTPS with a self-signed cert by default) before
        // starting the web app. server.ssl.* must be fixed before SpringApplication.run
        // (init does not start the UI, so it is not affected).
        TlsBootstrap.resolve();
        SpringApplication.run(ConfigToolApplication.class, args);
    }
}
