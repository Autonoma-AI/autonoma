/**
 * Isolated Resolution Agent Runner
 *
 * Runs the ResolutionAgent against a local or remote git repository without
 * requiring a database, Temporal, or GitHub App credentials.
 *
 * Usage:
 *   tsx src/run-resolution-isolated.ts \
 *     --repo <url-or-local-path> \
 *     --verdicts <path>           path to JSON file with RunReviewVerdict[]
 *     [--step1-result <path>]     path to Step 1 (DiffsAgent) JSON output
 *     [--tests-dir <path>]        dir containing qa-tests/ and skills/ (defaults to fixtures/)
 *     [--branch <name>]           branch to check out in a local repo or clone from a remote
 *     [--max-steps <n>]           agent step limit (default: 50)
 *
 * Natural chaining with the analysis runner:
 *   pnpm isolated --repo /path/to/repo --branch feature-x > step1-result.json
 *   pnpm isolated:resolve --repo /path/to/repo --branch feature-x \
 *     --verdicts fixtures/verdicts/sample.json \
 *     --step1-result step1-result.json \
 *     [--output <path>]            JSON result is written to this file instead of stdout
 *
 * Environment variables:
 *   GEMINI_API_KEY       required (real key)
 *   GROQ_KEY             required by @autonoma/ai schema (any non-empty value)
 *   OPENROUTER_API_KEY   required by @autonoma/ai schema (any non-empty value)
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import type { ResolutionAgentResult, RunReviewVerdict, TestCandidateInput } from "@autonoma/diffs";
import { runResolutionAgentLocally } from "@autonoma/diffs/run-resolution-locally";
import { TestDirectory } from "@autonoma/diffs/test-directory";
import { logger as rootLogger } from "@autonoma/logger";
import { type BaseCliArgs, parseBaseCliArgs, prepareRepo, readSkillFiles, readTestFiles } from "./isolated-utils";

// ---- CLI -------------------------------------------------------------------

interface CliArgs extends BaseCliArgs {
    verdicts: string;
    step1Result?: string;
    output?: string;
}

function parseCliArgs(): CliArgs {
    const { base, extra } = parseBaseCliArgs({
        verdicts: { type: "string" },
        "step1-result": { type: "string" },
        output: { type: "string" },
    });

    if (extra.verdicts == null) {
        throw new Error("--verdicts is required");
    }

    return {
        ...base,
        verdicts: extra.verdicts as string,
        step1Result: extra["step1-result"] as string | undefined,
        output: extra.output as string | undefined,
    };
}

// ---- Step 1 result loading -------------------------------------------------

interface Step1Result {
    reasoning: string;
    testCandidates: TestCandidateInput[];
}

async function loadStep1Result(path: string): Promise<Step1Result> {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return {
        reasoning: parsed.reasoning ?? "",
        testCandidates: parsed.testCandidates ?? [],
    };
}

// ---- Entry point -----------------------------------------------------------

async function run(args: CliArgs): Promise<void> {
    const logger = rootLogger.child({ name: "run-resolution-isolated" });

    logger.info("Starting isolated resolution analysis", {
        repo: args.repo,
        testsDir: args.testsDir,
        verdicts: args.verdicts,
        step1Result: args.step1Result,
        branch: args.branch,
        maxSteps: args.maxSteps,
    });

    const { repoDir, tempDir } = await prepareRepo(args);

    try {
        const testDirectory = await TestDirectory.create({
            workingDirectory: repoDir,
            tests: await readTestFiles(args.testsDir),
            skills: await readSkillFiles(args.testsDir),
        });

        const [existingTests, existingSkills] = await Promise.all([
            testDirectory.readTests(),
            testDirectory.readSkills(),
        ]);

        const verdictsRaw = await readFile(args.verdicts, "utf-8");
        const verdicts: RunReviewVerdict[] = JSON.parse(verdictsRaw);

        const { reasoning: step1Reasoning, testCandidates } =
            args.step1Result != null ? await loadStep1Result(args.step1Result) : { reasoning: "", testCandidates: [] };

        const registry = new ModelRegistry({
            models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
        });
        const model = registry.getModel({ model: "flash", tag: "resolution-isolated" });

        const startTime = Date.now();
        const result: ResolutionAgentResult = await runResolutionAgentLocally({
            model,
            repoDir,
            existingTests,
            existingSkills,
            testDirectory,
            verdicts,
            step1Reasoning,
            testCandidates,
            maxSteps: args.maxSteps,
        });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        logger.info("Run complete", {
            elapsed: `${elapsed}s`,
            modifiedTests: result.modifiedTests.length,
            quarantinedTests: result.quarantinedTests.length,
            reportedBugs: result.reportedBugs.length,
            newTests: result.newTests.length,
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
