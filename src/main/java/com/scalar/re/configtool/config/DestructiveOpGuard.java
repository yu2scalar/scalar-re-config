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
import org.springframework.stereotype.Component;

/**
 * Central decision for whether destructive DB operations (recreate / drop) may be allowed.
 *
 * <p>Enforces on the backend the rule that "recreate is allowed only when admin
 * authentication is enabled (not executable from the UI when started unauthenticated)":
 * {@link #allowed()} is derived from whether {@code ADMIN_PASSWORD} is set. Shared by
 * the recreate paths in {@link com.scalar.re.configtool.web.DbController} and by
 * {@link com.scalar.re.configtool.web.MetaController} (used by the frontend to disable the UI).
 *
 * <p>The CLI's {@code init --recreate-schema} is headless and operator-local, so it goes
 * through a separate path ({@link com.scalar.re.configtool.mode.InitRunner}, not via Spring)
 * and is outside this gate.
 */
@Component
public class DestructiveOpGuard {

    private final boolean authEnabled;

    public DestructiveOpGuard(@Value("${ADMIN_PASSWORD:}") String adminPassword) {
        this.authEnabled = adminPassword != null && !adminPassword.isBlank();
    }

    /** Destructive operations are allowed when authentication is enabled (ADMIN_PASSWORD set). */
    public boolean allowed() {
        return authEnabled;
    }
}
