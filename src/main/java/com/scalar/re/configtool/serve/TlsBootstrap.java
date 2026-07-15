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

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Locale;

/**
 * Startup TLS resolution for serve mode (mounted keystore and self-signed generation
 * both supported, with an explicit opt-out).
 *
 * <p>{@link com.scalar.re.configtool.ConfigToolApplication#main} calls {@link #resolve()}
 * <b>before</b> {@code SpringApplication.run} on the serve branch, fixing the final
 * {@code server.ssl.*} values via {@link System#setProperty} (system properties take
 * precedence over application.properties, so Spring picks them up as-is).
 *
 * <p>Resolution order:
 * <ol>
 *   <li>{@code TLS_ENABLED=false} → plain HTTP (no {@code server.ssl.*} is set at all).</li>
 *   <li>{@code TLS_KEYSTORE_PATH} + {@code TLS_KEYSTORE_PASSWORD} present → <b>A: use the mounted keystore</b>.</li>
 *   <li>Neither (default) → <b>B: auto-generate a self-signed cert with keytool</b> and serve HTTPS.</li>
 * </ol>
 *
 * <p>init mode does not start the UI (HTTP server), so this is never called there.
 * A missing keytool or a generation failure is fail-fast (exit with
 * {@link #TLS_BOOTSTRAP_FAILURE}) to avoid the trap of "keystore mount failed →
 * silently falls back to plain HTTP".
 */
public final class TlsBootstrap {

    /** Exit code when keytool is missing or self-signed generation fails (distinct from usage=2). */
    public static final int TLS_BOOTSTRAP_FAILURE = 3;

    private static final String CN = "ScalarRE Config Tool";
    private static final String SAN = "DNS:localhost,IP:127.0.0.1";
    private static final String ALIAS = "configtool";

    private TlsBootstrap() {}

    /** Resolves TLS from environment variables {@link System#getenv()} (called once before serve starts). */
    public static void resolve() {
        resolve(System.getenv());
    }

    /** Entry point that allows injecting env for tests. */
    public static void resolve(java.util.Map<String, String> env) {
        String tlsEnabled = env.get("TLS_ENABLED");
        if (tlsEnabled != null && tlsEnabled.equalsIgnoreCase("false")) {
            System.out.println("[tls] disabled (plain HTTP) — TLS_ENABLED=false");
            return;
        }

        String ksPath = trimToNull(env.get("TLS_KEYSTORE_PATH"));
        String ksPassword = env.get("TLS_KEYSTORE_PASSWORD");
        if (ksPath != null && ksPassword != null && !ksPassword.isEmpty()) {
            useMountedKeystore(ksPath, ksPassword, env);
            return;
        }

        generateSelfSigned();
    }

    /** A: use the mounted keystore as-is. */
    private static void useMountedKeystore(String path, String password, java.util.Map<String, String> env) {
        String type = trimToNull(env.get("TLS_KEYSTORE_TYPE"));
        if (type == null) {
            type = inferStoreType(path);
        }
        String alias = trimToNull(env.get("TLS_KEYSTORE_ALIAS"));

        setSslProps(toFileUrl(path), password, type, alias);
        System.out.println("[tls] using mounted keystore: " + path + " (type=" + type + ")");
    }

    /** B: generate a temporary self-signed PKCS12 keystore with keytool and use it. */
    private static void generateSelfSigned() {
        try {
            Path dir = Files.createTempDirectory("configtool-tls");
            Path keystore = dir.resolve("keystore.p12");
            dir.toFile().deleteOnExit();
            keystore.toFile().deleteOnExit();

            String password = randomPassword();
            int exit = runKeytool(keystore, password);
            if (exit != 0) {
                fail("keytool exited with code " + exit + " while generating self-signed cert");
            }
            if (!Files.exists(keystore)) {
                fail("keytool reported success but keystore was not created: " + keystore);
            }

            setSslProps(toFileUrl(keystore.toAbsolutePath().toString()), password, "PKCS12", ALIAS);
            System.out.println("[tls] generated self-signed cert (CN=" + CN
                    + ", SAN=localhost,127.0.0.1) — regenerated each restart; mount a keystore to pin");
        } catch (IOException e) {
            fail("failed to generate self-signed keystore: " + e.getMessage());
        }
    }

    private static int runKeytool(Path keystore, String password) {
        String keytool = keytoolPath();
        ProcessBuilder pb = new ProcessBuilder(
                keytool,
                "-genkeypair",
                "-alias", ALIAS,
                "-keyalg", "RSA",
                "-keysize", "2048",
                "-sigalg", "SHA256withRSA",
                "-validity", "3650",
                "-storetype", "PKCS12",
                "-keystore", keystore.toAbsolutePath().toString(),
                "-storepass", password,
                "-keypass", password,
                "-dname", "CN=" + CN,
                "-ext", "SAN=" + SAN);
        pb.redirectErrorStream(true);
        try {
            Process p = pb.start();
            // Discard keytool output (success is judged by exit code and keystore existence)
            p.getInputStream().readAllBytes();
            return p.waitFor();
        } catch (IOException e) {
            fail("keytool not runnable (" + keytool + "): " + e.getMessage());
            return TLS_BOOTSTRAP_FAILURE; // unreachable (fail() exits)
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            fail("interrupted while running keytool");
            return TLS_BOOTSTRAP_FAILURE; // unreachable
        }
    }

    /** Prefer JAVA_HOME/bin/keytool (PATH-independent); fall back to plain "keytool". */
    private static String keytoolPath() {
        String javaHome = System.getProperty("java.home");
        if (javaHome != null && !javaHome.isBlank()) {
            String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
            String bin = javaHome + "/bin/keytool" + (os.contains("win") ? ".exe" : "");
            if (Files.isExecutable(Path.of(bin))) {
                return bin;
            }
        }
        return "keytool";
    }

    private static void setSslProps(String keyStoreUrl, String password, String type, String alias) {
        System.setProperty("server.ssl.enabled", "true");
        System.setProperty("server.ssl.key-store", keyStoreUrl);
        System.setProperty("server.ssl.key-store-password", password);
        System.setProperty("server.ssl.key-store-type", type);
        if (alias != null) {
            System.setProperty("server.ssl.key-alias", alias);
        }
    }

    private static String inferStoreType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".jks")) {
            return "JKS";
        }
        return "PKCS12"; // .p12/.pfx and unknown extensions default to PKCS12
    }

    private static String toFileUrl(String path) {
        // Ensure Spring's server.ssl.key-store resolves reliably via the file:/abs/path form.
        if (path.startsWith("file:") || path.startsWith("classpath:")) {
            return path;
        }
        return "file:" + path;
    }

    private static String randomPassword() {
        byte[] buf = new byte[24];
        new SecureRandom().nextBytes(buf);
        return HexFormat.of().formatHex(buf);
    }

    private static String trimToNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static void fail(String message) {
        System.err.println("[tls] FATAL: " + message);
        System.err.println("[tls] refusing to start without TLS. "
                + "Set TLS_ENABLED=false to run plain HTTP, or fix the keystore.");
        System.exit(TLS_BOOTSTRAP_FAILURE);
    }
}
