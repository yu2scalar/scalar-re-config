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

import com.scalar.re.configtool.model.ValidationError;
import com.scalar.re.configtool.service.DbVerifyService;
import com.scalar.re.configtool.service.GeneratorService;
import com.scalar.re.configtool.service.PlaceholderResolver;
import com.scalar.re.configtool.service.SchemaInitService;
import com.scalar.re.configtool.service.ValidatorService;
import java.util.Map;

/**
 * init mode (headless one-shot run).
 *
 * <p>Flow: load the config → validate → <b>DB verify</b> (non-destructive connectivity) →
 * unless verify-only, <b>DB init</b> (schema creation; {@code --recreate-schema} for
 * destructive recreation) → exit code.
 *
 * <p>No Spring context is started ({@link GeneratorService} / {@link ValidatorService} /
 * {@link DbVerifyService} / {@link SchemaInitService} are dependency-free POJOs and are
 * instantiated directly). No web server is started either, so this is truly headless.
 *
 * <p>Exit codes: 0=success / 1=load failure, validation error, verify failure, or init
 * failure / 2=usage (missing --config). Logs go to stdout (progress, success) and
 * stderr (errors).
 */
public final class InitRunner {

    static final int OK = 0;
    static final int FAILURE = 1;
    static final int USAGE = 2;

    private InitRunner() {}

    public static int run(ModeOptions opts) {
        if (opts.configPath() == null || opts.configPath().isBlank()) {
            System.err.println("[init] --config=<path> is required for --mode=init");
            return USAGE;
        }

        System.out.println("[init] ScalarRE Config Tool — headless init");
        System.out.println("[init] config: " + opts.configPath()
                + (opts.verifyOnly() ? " (verify-only)" : ""));

        Map<String, Object> config;
        try {
            config = new GeneratorService().loadYaml(opts.configPath());
        } catch (Exception e) {
            System.err.println("[init] FAILED to load config: " + e.getMessage());
            System.err.println("[init] result: FAILURE (exit " + FAILURE + ")");
            return FAILURE;
        }

        ValidatorService.Result result = new ValidatorService().validate(config);

        // Warnings such as deprecations (do not affect validity)
        for (ValidationError w : result.warnings()) {
            System.out.println("[init] warning  " + w.path() + " — " + w.message());
        }

        if (!result.errors().isEmpty()) {
            for (ValidationError e : result.errors()) {
                System.err.println("[init] error    " + e.path() + " — " + e.message());
            }
            System.err.println("[init] validation: " + result.errors().size() + " error(s)");
            System.err.println("[init] result: FAILURE (exit " + FAILURE + ")");
            return FAILURE;
        }
        System.out.println("[init] validation: OK");

        // DB verify → init. Instantiate the dependency-free POJO services directly (stays headless).
        GeneratorService generator = new GeneratorService();
        PlaceholderResolver resolver = new PlaceholderResolver();
        DbVerifyService verifyService = new DbVerifyService(generator, resolver);

        DbVerifyService.VerifyResult vr = verifyService.verify(config);
        if (!vr.reachable()) {
            System.err.println("[init] db verify: FAILED (" + vr.errorType() + ": " + vr.errorMessage() + ")");
            System.err.println("[init] result: FAILURE (exit " + FAILURE + ")");
            return FAILURE;
        }
        System.out.println("[init] db verify: OK (namespaces=" + vr.namespaces() + ", " + vr.elapsedMs() + "ms)");

        if (opts.verifyOnly()) {
            System.out.println("[init] verify-only: skipping schema init");
            System.out.println("[init] result: SUCCESS (exit " + OK + ")");
            return OK;
        }

        if (opts.recreateSchema()) {
            System.out.println("[init] !!! recreate-schema: DROPPING all RE tables then recreating (DATA LOSS) !!!");
        }
        SchemaInitService initService = new SchemaInitService(generator, resolver);
        SchemaInitService.InitResult ir = initService.init(config, opts.recreateSchema());
        if (!ir.ok()) {
            System.err.println("[init] db init (" + ir.mode() + "): FAILED ("
                    + ir.errorType() + ": " + ir.errorMessage() + ")");
            System.err.println("[init] created=" + ir.created() + " dropped=" + ir.dropped());
            System.err.println("[init] result: FAILURE (exit " + FAILURE + ")");
            return FAILURE;
        }
        System.out.println("[init] db init (" + ir.mode() + "): OK"
                + " created=" + ir.created().size()
                + " skipped=" + ir.skipped().size()
                + " dropped=" + ir.dropped().size()
                + " indexes=" + ir.indexes().size()
                + " (" + ir.elapsedMs() + "ms)");

        System.out.println("[init] result: SUCCESS (exit " + OK + ")");
        return OK;
    }
}
