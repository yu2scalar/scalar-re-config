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

package com.scalar.re.configtool.serve;

import java.net.InetAddress;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * Auto-opens the browser after the web server finishes starting in serve mode.
 *
 * <p>Decision (open only when the bind is loopback, with an env override):
 * <ul>
 *   <li>Opens only when the resolved {@code server.address} is loopback
 *       (127.0.0.1 / ::1). Containers run with {@code SERVER_ADDRESS=0.0.0.0}
 *       (non-loopback), so the browser is not opened there — local runs map to
 *       loopback, container runs map to 0.0.0.0.</li>
 *   <li>{@code CONFIG_TOOL_OPEN_BROWSER=false} (or 0) disables it explicitly (CI / headless).</li>
 * </ul>
 *
 * <p>init mode does not start a Spring context, so this listener only runs in serve.
 */
@Component
public class BrowserLauncher implements ApplicationListener<ApplicationReadyEvent> {

    @Override
    public void onApplicationEvent(ApplicationReadyEvent event) {
        Environment env = event.getApplicationContext().getEnvironment();
        String address = env.getProperty("server.address", "127.0.0.1");
        String port = env.getProperty("server.port", "8088");

        boolean loopback;
        try {
            loopback = InetAddress.getByName(address).isLoopbackAddress();
        } catch (Exception e) {
            loopback = false;
        }

        String host = loopback ? address : "127.0.0.1";
        // Use https when TLS is enabled (TlsBootstrap has set server.ssl.key-store).
        String scheme = env.getProperty("server.ssl.key-store") != null ? "https" : "http";
        String url = scheme + "://" + host + ":" + port;

        if (!loopback) {
            System.out.println("[serve] listening on " + address + ":" + port
                    + " (non-loopback bind — browser auto-open disabled)");
            return;
        }

        System.out.println("[serve] ScalarRE Config Tool started at " + url);

        if (!openBrowserEnabled()) {
            System.out.println("[serve] browser auto-open disabled (CONFIG_TOOL_OPEN_BROWSER)");
            return;
        }
        openBrowser(url);
    }

    private static boolean openBrowserEnabled() {
        String v = System.getenv("CONFIG_TOOL_OPEN_BROWSER");
        if (v == null) {
            return true; // enabled by default
        }
        return !v.equalsIgnoreCase("false") && !v.equals("0");
    }

    /** Port of the Go version's openBrowser (xdg-open / open / rundll32). Failures are ignored. */
    private static void openBrowser(String url) {
        String os = System.getProperty("os.name", "").toLowerCase();
        try {
            ProcessBuilder pb;
            if (os.contains("linux")) {
                pb = new ProcessBuilder("xdg-open", url);
            } else if (os.contains("mac") || os.contains("darwin")) {
                pb = new ProcessBuilder("open", url);
            } else if (os.contains("win")) {
                pb = new ProcessBuilder("rundll32", "url.dll,FileProtocolHandler", url);
            } else {
                return;
            }
            pb.start();
        } catch (Exception ignored) {
            // serve continues even if the browser cannot be opened (same as the Go version's _ = cmd.Start())
        }
    }
}
