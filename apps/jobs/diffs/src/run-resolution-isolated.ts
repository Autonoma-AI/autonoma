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
 *     [--scenarios <path>]        path to JSON file with ScenarioInfo[] (enables list_scenarios / read_scenario)
 *     [--tests-dir <path>]        dir containing qa-tests/ (defaults to fixtures/)
 *     [--branch <name>]           branch to check out in a local repo or clone from a remote
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
import type { LocalTestCandidateInput, ResolutionAgentResult, RunReviewVerdict, ScenarioInfo } from "@autonoma/diffs";
import { runResolutionAgentLocally } from "@autonoma/diffs/run-resolution-locally";
import { logger as rootLogger } from "@autonoma/logger";
import { type BaseCliArgs, parseBaseCliArgs, prepareRepo, readTestFiles } from "./isolated-utils";

// ---- CLI -------------------------------------------------------------------

interface CliArgs extends BaseCliArgs {
    verdicts: string;
    step1Result?: string;
    scenarios?: string;
    output?: string;
}

function parseCliArgs(): CliArgs {
    const { base, extra } = parseBaseCliArgs({
        verdicts: { type: "string" },
        "step1-result": { type: "string" },
        scenarios: { type: "string" },
        output: { type: "string" },
    });

    if (extra.verdicts == null) {
        throw new Error("--verdicts is required");
    }

    return {
        ...base,
        verdicts: extra.verdicts as string,
        step1Result: extra["step1-result"] as string | undefined,
        scenarios: extra.scenarios as string | undefined,
        output: extra.output as string | undefined,
    };
}

// ---- Step 1 result loading -------------------------------------------------

interface Step1Result {
    reasoning: string;
    testCandidates: LocalTestCandidateInput[];
}

async function loadStep1Result(path: string): Promise<Step1Result> {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return {
        reasoning: parsed.reasoning ?? "",
        testCandidates: parsed.testCandidates ?? [],
    };
}

async function loadScenarios(path: string): Promise<ScenarioInfo[]> {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error(`Scenarios file at ${path} must contain a JSON array of ScenarioInfo`);
    }
    return parsed as ScenarioInfo[];
}

// ---- Entry point -----------------------------------------------------------

async function run(args: CliArgs): Promise<void> {
    const logger = rootLogger.child({ name: "run-resolution-isolated" });

    logger.info("Starting isolated resolution analysis", {
        repo: args.repo,
        testsDir: args.testsDir,
        verdicts: args.verdicts,
        step1Result: args.step1Result,
        scenarios: args.scenarios,
        branch: args.branch,
    });

    const { repoDir, tempDir } = await prepareRepo(args);

    try {
        const existingTests = await readTestFiles(args.testsDir);

        const verdictsRaw = await readFile(args.verdicts, "utf-8");
        const verdicts: RunReviewVerdict[] = JSON.parse(verdictsRaw);

        const { reasoning: step1Reasoning, testCandidates } =
            args.step1Result != null ? await loadStep1Result(args.step1Result) : { reasoning: "", testCandidates: [] };

        const scenarios = args.scenarios != null ? await loadScenarios(args.scenarios) : undefined;

        const registry = new ModelRegistry({
            models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
        });
        const model = registry.getModel({ model: "flash", tag: "resolution-isolated" });

        const startTime = Date.now();
        const result: ResolutionAgentResult = await runResolutionAgentLocally({
            model,
            repoDir,
            existingTests,
            verdicts,
            step1Reasoning,
            testCandidates,
            scenarios,
        });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        logger.info("Run complete", {
            elapsed: `${elapsed}s`,
            modifiedTests: result.modifiedTests.length,
            removedTests: result.removedTests.length,
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
