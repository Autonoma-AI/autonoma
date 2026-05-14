/**
 * Isolated Diffs Analysis Runner
 *
 * Runs the DiffsAgent against a local or remote git repository without
 * requiring a database, Temporal, or GitHub App credentials.
 *
 * Usage:
 *   tsx src/run-diffs-isolated.ts \
 *     --repo <url-or-local-path> \
 *     [--tests-dir <path>]       dir containing qa-tests/ and skills/ (defaults to fixtures/)
 *     [--branch <name>]          resolves base = merge-base(main, branch), head = branch tip
 *     [--base <ref>]             explicit base commit (default: HEAD~1)
 *     [--head <ref>]             explicit head commit (default: HEAD)
 *     [--max-steps <n>]          agent step limit (default: 50)
 *     [--output <path>]          JSON result is written to this file
 *
 * Environment variables:
 *   GEMINI_API_KEY       required (real key)
 *   GROQ_KEY             required by @autonoma/ai schema (any non-empty value)
 *   OPENROUTER_API_KEY   required by @autonoma/ai schema (any non-empty value)
 */

import { rm, writeFile } from "node:fs/promises";
import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import type { DiffsAgentResult } from "@autonoma/diffs";
import { runDiffsAgentLocally } from "@autonoma/diffs/run-diffs-locally";
import { logger as rootLogger } from "@autonoma/logger";
import {
    type BaseCliArgs,
    parseBaseCliArgs,
    prepareRepo,
    readSkillFiles,
    readTestFiles,
    resolveCommits,
} from "./isolated-utils";

// ---- CLI -------------------------------------------------------------------

interface CliArgs extends BaseCliArgs {
    output?: string;
}

function parseCliArgs(): CliArgs {
    const { base, extra } = parseBaseCliArgs({ output: { type: "string" } });
    return { ...base, output: extra.output as string | undefined };
}

// ---- Entry point -----------------------------------------------------------

async function run(args: CliArgs): Promise<void> {
    const logger = rootLogger.child({ name: "run-diffs-isolated" });

    logger.info("Starting isolated diffs analysis", {
        repo: args.repo,
        testsDir: args.testsDir,
        branch: args.branch,
        base: args.base,
        head: args.head,
        maxSteps: args.maxSteps,
    });

    const { repoDir, tempDir } = await prepareRepo(args);

    try {
        const { baseSha, headSha } = await resolveCommits(repoDir, args);

        const [existingTests, existingSkills] = await Promise.all([
            readTestFiles(args.testsDir),
            readSkillFiles(args.testsDir),
        ]);

        const registry = new ModelRegistry({
            models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
        });
        const model = registry.getModel({ model: "flash", tag: "diffs-isolated" });

        const startTime = Date.now();
        const result: DiffsAgentResult = await runDiffsAgentLocally({
            model,
            repoDir,
            baseSha,
            headSha,
            existingTests,
            existingSkills,
            maxSteps: args.maxSteps,
        });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        logger.info("Run complete", {
            elapsed: `${elapsed}s`,
            affectedTests: result.affectedTests.length,
            testCandidates: result.testCandidates.length,
            modelUsage: registry.modelUsage,
        });

        const json = JSON.stringify(result, null, 2) + "\n";
        if (args.output != null) {
            await writeFile(args.output, json, "utf-8");
            logger.info("Result written to file", { output: args.output });
        } else {
            process.stdout.write(json);
        }
    } finally {
        if (tempDir != null) {
            await rm(tempDir, { recursive: true, force: true });
        }
    }
}

await run(parseCliArgs());
