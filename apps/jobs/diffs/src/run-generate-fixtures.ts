/**
 * Generate Fixtures Script
 *
 * Takes prompt-only test fixtures (markdown files), runs each through the
 * execution agent (generation) against a live application, and saves the
 * recorded steps as companion .steps.json files alongside the markdown.
 *
 * After running this script, each test fixture will have both:
 *   - {slug}.md          - the test prompt (unchanged)
 *   - {slug}.steps.json  - the recorded steps for replay
 *
 * Usage:
 *   tsx src/run-generate-fixtures.ts \
 *     --url <application-url> \
 *     [--tests-dir <path>]     dir with qa-tests/ (defaults to fixtures/)
 *     [--headless]             run browser headless (default: true)
 *     [--filter <slug>]        only generate for a specific test slug
 *     [--force]                regenerate even if .steps.json already exists
 *
 * Environment variables:
 *   GEMINI_API_KEY       required
 *   GROQ_KEY             required by @autonoma/ai schema (any non-empty value)
 *   OPENROUTER_API_KEY   required by @autonoma/ai schema (any non-empty value)
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CostCollector } from "@autonoma/ai";
import { logger as rootLogger } from "@autonoma/logger";
import { DEFAULT_TESTS_DIR, readTestFiles } from "./isolated-utils";
import { runTestLocally } from "./run-test-locally";

interface GenerateFixturesArgs {
    url: string;
    testsDir: string;
    headless: boolean;
    filter?: string;
    force: boolean;
}

function parseCliArgs(): GenerateFixturesArgs {
    const { values } = parseArgs({
        options: {
            url: { type: "string" },
            "tests-dir": { type: "string" },
            headless: { type: "boolean" },
            filter: { type: "string" },
            force: { type: "boolean" },
        },
        strict: true,
    });

    if (values.url == null) {
        throw new Error("--url is required");
    }

    return {
        url: values.url,
        testsDir: values["tests-dir"] ?? DEFAULT_TESTS_DIR,
        headless: values.headless ?? true,
        filter: values.filter,
        force: values.force ?? false,
    };
}

async function generateFixtures(args: GenerateFixturesArgs): Promise<void> {
    const logger = rootLogger.child({ name: "run-generate-fixtures" });

    logger.info("Starting fixture generation", {
        url: args.url,
        testsDir: args.testsDir,
        filter: args.filter,
        force: args.force,
    });

    const tests = await readTestFiles(args.testsDir);
    const costCollector = new CostCollector();
    const qaTestsDir = join(args.testsDir, "qa-tests");

    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (const test of tests) {
        if (args.filter != null && test.slug !== args.filter) continue;

        if (test.steps != null && !args.force) {
            logger.info("Test already has steps, skipping (use --force to regenerate)", { slug: test.slug });
            skipped++;
            continue;
        }

        logger.info("Generating steps for test", { slug: test.slug, name: test.name });

        const result = await runTestLocally({
            instruction: test.prompt,
            url: args.url,
            testSlug: test.slug,
            outputDir: join(args.testsDir, ".generation-artifacts"),
            headless: args.headless,
            costCollector,
        });

        if (!result.success) {
            logger.warn("Generation failed, skipping fixture save", {
                slug: test.slug,
                reason: result.reasoning,
            });
            failed++;
            continue;
        }

        const stepsForReplay = result.steps.map((step) => ({
            interaction: step.interaction,
            params: step.params,
            ...(step.waitCondition != null ? { waitCondition: step.waitCondition } : {}),
        }));

        const stepsPath = join(qaTestsDir, `${test.slug}.steps.json`);
        await writeFile(stepsPath, JSON.stringify(stepsForReplay, null, 2) + "\n", "utf-8");

        logger.info("Steps saved", { slug: test.slug, stepCount: stepsForReplay.length, path: stepsPath });
        generated++;
    }

    logger.info("Fixture generation complete", { generated, skipped, failed });
}

await generateFixtures(parseCliArgs());
