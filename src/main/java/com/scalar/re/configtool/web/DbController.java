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
import com.scalar.re.configtool.service.DbVerifyService;
import com.scalar.re.configtool.service.DbVerifyService.VerifyResult;
import com.scalar.re.configtool.service.SchemaInitService;
import com.scalar.re.configtool.service.SchemaInitService.InitResult;
import com.scalar.re.configtool.service.SchemaInitService.NamespaceOp;
import com.scalar.re.configtool.service.SchemaInitService.NamespaceStatus;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * DB operation endpoints (deploy/admin layer): non-destructive verify, schema init,
 * and per-resource operations.
 *
 * <p>These act on the DB directly at deploy time, independent of the RE runtime
 * (the core's read-only inspect API).
 *
 * <p>Connection failures are also returned as HTTP 200 + {@code reachable:false}
 * (easier for the UI to render the result).
 */
@RestController
@RequestMapping("/api/db")
public class DbController {

    private final DbVerifyService verifyService;
    private final SchemaInitService initService;
    private final DestructiveOpGuard destructiveOpGuard;

    public DbController(DbVerifyService verifyService, SchemaInitService initService,
            DestructiveOpGuard destructiveOpGuard) {
        this.verifyService = verifyService;
        this.initService = initService;
        this.destructiveOpGuard = destructiveOpGuard;
    }

    @PostMapping("/verify")
    public Map<String, Object> verify(@RequestBody Map<String, Object> config) {
        VerifyResult r = verifyService.verify(config);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("reachable", r.reachable());
        resp.put("namespaces", r.namespaces());
        resp.put("elapsedMs", r.elapsedMs());
        if (!r.reachable()) {
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("type", r.errorType());
            err.put("message", r.errorMessage());
            resp.put("error", err);
        }
        return resp;
    }

    /**
     * RE schema creation. Default is an idempotent create.
     *
     * <p>Destructive recreate requires explicit opt-in:
     * {@code ?recreate=true&confirm=true}. Even with {@code recreate=true}, the request
     * is rejected with 400 unless {@code confirm} is set (guards against accidental runs).
     */
    @PostMapping("/init")
    public ResponseEntity<Map<String, Object>> init(
            @RequestBody Map<String, Object> config,
            @RequestParam(name = "recreate", defaultValue = "false") boolean recreate,
            @RequestParam(name = "confirm", defaultValue = "false") boolean confirm) {

        // recreate (destructive) is only allowed when admin authentication is enabled.
        if (recreate && !destructiveOpGuard.allowed()) {
            return authRequired("recreate", null);
        }
        if (recreate && !confirm) {
            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("ok", false);
            resp.put("mode", "recreate");
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("type", "ConfirmationRequired");
            err.put("message", "recreate is destructive (drops all RE tables). "
                    + "Pass confirm=true to proceed.");
            resp.put("error", err);
            return ResponseEntity.badRequest().body(resp);
        }

        InitResult r = initService.init(config, recreate);
        return ResponseEntity.ok(opResponse(r.ok(), r.mode(), r.created(), r.skipped(), r.dropped(),
                r.indexes(), r.elapsedMs(), null, r.errorType(), r.errorMessage()));
    }

    // --- per-resource operations. All are POSTs taking the config in the body ----------

    /** Connectivity check for a single storage (non-destructive). */
    @PostMapping("/storages/{name}/verify")
    public Map<String, Object> verifyStorage(
            @PathVariable("name") String name, @RequestBody Map<String, Object> config) {
        VerifyResult r = verifyService.verifyStorage(config, name);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("storage", name);
        resp.put("reachable", r.reachable());
        resp.put("namespaces", r.namespaces());
        resp.put("target", r.target());
        resp.put("elapsedMs", r.elapsedMs());
        if (!r.reachable()) {
            resp.put("error", errorMap(r.errorType(), r.errorMessage()));
        }
        return resp;
    }

    /** Namespace status check (namespace existence + expected RE tables, non-destructive). */
    @PostMapping("/namespaces/{name}/status")
    public Map<String, Object> namespaceStatus(
            @PathVariable("name") String name, @RequestBody Map<String, Object> config) {
        NamespaceStatus s = initService.namespaceStatus(config, name);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("namespace", name);
        resp.put("ok", s.ok());
        resp.put("namespaceExists", s.namespaceExists());
        resp.put("healthy", s.healthy());
        resp.put("target", s.target());
        java.util.List<Map<String, Object>> tables = new java.util.ArrayList<>();
        for (var t : s.tables()) {
            Map<String, Object> tm = new LinkedHashMap<>();
            tm.put("table", t.table());
            tm.put("exists", t.exists());
            tables.add(tm);
        }
        resp.put("tables", tables);
        resp.put("elapsedMs", s.elapsedMs());
        if (!s.ok()) {
            resp.put("error", errorMap(s.errorType(), s.errorMessage()));
        }
        return resp;
    }

    /** Namespace creation (idempotent). */
    @PostMapping("/namespaces/{name}/create")
    public Map<String, Object> createNamespace(
            @PathVariable("name") String name, @RequestBody Map<String, Object> config) {
        NamespaceOp r = initService.createNamespace(config, name);
        Map<String, Object> resp = opResponse(r.ok(), r.mode(), r.created(), r.skipped(), r.dropped(),
                r.indexes(), r.elapsedMs(), r.target(), r.errorType(), r.errorMessage());
        resp.put("namespace", name);
        return resp;
    }

    /** Namespace recreation (destructive: drops tables/namespace then recreates; confirm required). */
    @PostMapping("/namespaces/{name}/recreate")
    public ResponseEntity<Map<String, Object>> recreateNamespace(
            @PathVariable("name") String name,
            @RequestBody Map<String, Object> config,
            @RequestParam(name = "confirm", defaultValue = "false") boolean confirm) {
        // recreate (destructive) is only allowed when admin authentication is enabled.
        if (!destructiveOpGuard.allowed()) {
            return authRequired("recreate", name);
        }
        if (!confirm) {
            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("namespace", name);
            resp.put("ok", false);
            resp.put("mode", "recreate");
            resp.put("error", errorMap("ConfirmationRequired",
                    "recreate is destructive (drops namespace '" + name + "' and its RE tables). "
                            + "Pass confirm=true to proceed."));
            return ResponseEntity.badRequest().body(resp);
        }
        NamespaceOp r = initService.recreateNamespace(config, name);
        Map<String, Object> resp = opResponse(r.ok(), r.mode(), r.created(), r.skipped(), r.dropped(),
                r.indexes(), r.elapsedMs(), r.target(), r.errorType(), r.errorMessage());
        resp.put("namespace", name);
        return ResponseEntity.ok(resp);
    }

    private static Map<String, Object> opResponse(boolean ok, String mode, java.util.List<String> created,
            java.util.List<String> skipped, java.util.List<String> dropped, java.util.List<String> indexes,
            long elapsedMs, String target, String errorType, String errorMessage) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("ok", ok);
        resp.put("mode", mode);
        resp.put("created", created);
        resp.put("skipped", skipped);
        resp.put("dropped", dropped);
        resp.put("indexes", indexes);
        if (target != null) {
            resp.put("target", target);
        }
        resp.put("elapsedMs", elapsedMs);
        if (!ok) {
            resp.put("error", errorMap(errorType, errorMessage));
        }
        return resp;
    }

    /**
     * 403 response for a destructive operation rejected by the admin-auth gate.
     * {@code namespace} is set for per-namespace recreate, null for whole-config recreate.
     */
    private static ResponseEntity<Map<String, Object>> authRequired(String mode, String namespace) {
        Map<String, Object> resp = new LinkedHashMap<>();
        if (namespace != null) {
            resp.put("namespace", namespace);
        }
        resp.put("ok", false);
        resp.put("mode", mode);
        resp.put("error", errorMap("AuthRequired",
                "Destructive operations require admin authentication. "
                        + "Start the tool with ADMIN_PASSWORD set to enable recreate."));
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(resp);
    }

    private static Map<String, Object> errorMap(String type, String message) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("type", type);
        err.put("message", message);
        return err;
    }
}
