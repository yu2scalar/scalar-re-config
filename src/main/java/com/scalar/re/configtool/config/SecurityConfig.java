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

package com.scalar.re.configtool.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Protection for the serve-mode UI / API.
 *
 * <p>HTTP Basic is required <b>only when {@code ADMIN_PASSWORD} is set</b>. If unset,
 * everything is permitAll (= no authentication). Basic is used for now (minimal
 * implementation); promote to form login if a proper login screen is ever needed.
 *
 * <ul>
 *   <li>permitAll (bypass): {@code GET /}, static assets, and {@code /api/meta}
 *       (used by the frontend to decide the recreate gate).</li>
 *   <li>Authentication required: everything else under {@code /api/**}
 *       (validate / preview / save / load / db/**) and the UI.</li>
 * </ul>
 *
 * <p>init mode does not start a Spring context, so this config only applies to serve.
 * Basic sends credentials base64-encoded, so it is used together with the TLS from
 * {@link com.scalar.re.configtool.serve.TlsBootstrap} (HTTPS by default).
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    private final boolean authEnabled;
    private final String adminPassword;

    public SecurityConfig(@Value("${ADMIN_PASSWORD:}") String adminPassword) {
        this.adminPassword = adminPassword;
        this.authEnabled = adminPassword != null && !adminPassword.isBlank();
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        // The API is stateless (Basic), so CSRF is disabled.
        http.csrf(csrf -> csrf.disable());

        if (authEnabled) {
            http.authorizeHttpRequests(auth -> auth
                            .requestMatchers("/", "/index.html", "/favicon.ico", "/vite.svg",
                                    "/assets/**", "/api/meta")
                            .permitAll()
                            .anyRequest().authenticated())
                    .httpBasic(Customizer.withDefaults());
            System.out.println("[auth] HTTP Basic enabled (ADMIN_PASSWORD set) — user=admin");
        } else {
            http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
            System.out.println("[auth] disabled (ADMIN_PASSWORD not set) — all requests permitted");
        }
        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    /**
     * Single admin user. Even when authentication is disabled, a dummy user is registered
     * to suppress Spring Boot's "Using generated security password" auto-user (and its
     * startup log line); with permitAll the credentials are never used.
     */
    @Bean
    public UserDetailsService userDetailsService(PasswordEncoder encoder) {
        String password = authEnabled ? adminPassword : java.util.UUID.randomUUID().toString();
        UserDetails admin = User.withUsername("admin")
                .password(encoder.encode(password))
                .roles("ADMIN")
                .build();
        return new InMemoryUserDetailsManager(admin);
    }
}
