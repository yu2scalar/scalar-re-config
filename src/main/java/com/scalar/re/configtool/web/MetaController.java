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

package com.scalar.re.configtool.web;

import com.scalar.re.configtool.config.DestructiveOpGuard;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Lightweight meta information available without authentication.
 *
 * <p>Fetched once at startup by the frontend to decide whether the recreate button
 * may be shown. Marked permitAll (bypass) in SecurityConfig.
 *
 * <pre>GET /api/meta → { "authEnabled": bool, "destructiveOpsAllowed": bool }</pre>
 */
@RestController
public class MetaController {

    private final boolean authEnabled;
    private final DestructiveOpGuard destructiveOpGuard;

    public MetaController(
            @Value("${ADMIN_PASSWORD:}") String adminPassword, DestructiveOpGuard destructiveOpGuard) {
        this.authEnabled = adminPassword != null && !adminPassword.isBlank();
        this.destructiveOpGuard = destructiveOpGuard;
    }

    @GetMapping("/api/meta")
    public Map<String, Object> meta() {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("authEnabled", authEnabled);
        resp.put("destructiveOpsAllowed", destructiveOpGuard.allowed());
        return resp;
    }
}
