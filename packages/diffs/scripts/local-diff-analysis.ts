/**
 * Run the diffs agent against a real git repository, sourcing the existing
 * tests/flows from the database for a given snapshot.
 *
 * Usage:
 *   pnpm local-diff-analysis <repo-path> --snapshot=<snapshotId> [--model=flash|glm|kimi]
 *
 * The repo must have at least 2 commits (the agent diffs HEAD~1..HEAD).
 *
 * Example:
 *   pnpm local-diff-analysis /path/to/appium-navigator --snapshot=snap_123 --model=flash
 */

import { execSync } from "node:child_process";
import { MODEL_ENTRIES, ModelRegistry, openRouterProvider, simpleCostFunction } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { fetchTestSuiteInfo } from "@autonoma/test-updates";
import type { DiffsAgentInput } from "../src/diffs-agent";
import { DiffsAgent } from "../src/diffs-agent";
import { FlowIndex } from "../src/flow-index";
import { loadFlows } from "../src/loaders/load-flows";
import { mapTestSuiteToContext } from "../src/loaders/map-suite-to-context";

// --- Model setup ---

const MODEL_OPTIONS = {
    flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW,
    glm: {
        createModel: () => openRouterProvider.getModel("z-ai/glm-5-turbo"),
        pricing: simpleCostFunction({ inputCostPerM: 0.96, outputCostPerM: 3.2 }),
    },
    kimi: {
        createModel: () => openRouterProvider.getModel("moonshotai/kimi-k2.5"),
        pricing: simpleCostFunction({ inputCostPerM: 0.45, outputCostPerM: 2.2 }),
    },
} as const;

type ModelKey = keyof typeof MODEL_OPTIONS;

// --- CLI args ---

const args = process.argv.slice(2);
const modelFlag = args.find((a) => a.startsWith("--model="))?.split("=")[1] as ModelKey | undefined;
const modelKey: ModelKey = modelFlag ?? "flash";
const snapshotId = args.find((a) => a.startsWith("--snapshot="))?.split("=")[1];

function usage(): never {
    console.error("Usage: pnpm local-diff-analysis <repo-path> --snapshot=<snapshotId> [--model=flash|glm|kimi]");
    process.exit(1);
}

function getRepoPath(): string {
    const path = args.find((a) => !a.startsWith("--"));
    if (path == null) usage();
    return path;
}

if (snapshotId == null || snapshotId.length === 0) usage();

const repoPath = getRepoPath();

// --- Helpers ---

function git(cwd: string, command: string): string {
    return execSync(`git ${command}`, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

async function resolveApplicationId(snapId: string): Promise<string> {
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapId },
        select: { branch: { select: { applicationId: true } } },
    });
    if (snapshot == null) {
        throw new Error(`Snapshot ${snapId} not found`);
    }
    return snapshot.branch.applicationId;
}

// --- Main ---

async function main() {
    console.log("\n=== Diffs Agent - Real Repo Test ===");
    console.log(`Repo: ${repoPath}`);
    console.log(`Snapshot: ${snapshotId}`);
    console.log(`Model: ${modelKey}`);
    console.log();

    const affectedFiles = git(repoPath, "diff HEAD~1 HEAD --name-only")
        .split("\n")
        .filter((f) => f.length > 0);
    const diffStat = git(repoPath, "diff HEAD~1 HEAD --stat");
    const commitMessage = git(repoPath, "log -1 --format=%s");
    const headSha = git(repoPath, "rev-parse HEAD");
    const baseSha = git(repoPath, "rev-parse HEAD~1");

    console.log(`Commit: ${commitMessage}`);
    console.log(`Affected files: ${affectedFiles.length}`);
    console.log(diffStat);
    console.log();

    const applicationId = await resolveApplicationId(snapshotId!);
    const suiteInfo = await fetchTestSuiteInfo(db, snapshotId!);
    const { existingTests } = mapTestSuiteToContext(suiteInfo);
    const flows = await loadFlows(db, applicationId, suiteInfo);

    console.log(`Loaded ${existingTests.length} tests, ${flows.length} flows`);
    console.log();

    const input: DiffsAgentInput = {
        headSha,
        baseSha,
        existingTests,
    };

    const registry = new ModelRegistry({ models: MODEL_OPTIONS });
    const model = registry.getModel({ model: modelKey, tag: "diffs-script" });

    console.log("--- Starting agent ---\n");
    const startTime = Date.now();

    const flowIndex = new FlowIndex(flows);

    const agent = new DiffsAgent({
        model,
        workingDirectory: repoPath,
        flowIndex,
    });

    const result = await agent.analyze(input);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n\n=== RESULTS (${elapsed}s) ===\n`);

    console.log(`Reasoning: ${result.reasoning}\n`);

    if (result.affectedTests.length > 0) {
        console.log(`--- Affected Tests (${result.affectedTests.length}) ---`);
        for (const test of result.affectedTests) {
            console.log(`  AFFECTED: ${test.slug} (${test.testName})`);
            console.log(`    Reason: ${test.reasoning}`);
        }
        console.log();
    }

    if (result.testCandidates.length > 0) {
        console.log(`--- Test Candidates (${result.testCandidates.length}) ---`);
        for (const test of result.testCandidates) {
            console.log(`  CANDIDATE: ${test.name}`);
            console.log(`    Reason: ${test.reasoning}`);
            console.log(`    Instruction: ${test.instruction.slice(0, 200)}...`);
        }
        console.log();
    }

    console.log("--- Summary ---");
    console.log(`  Affected tests: ${result.affectedTests.length}`);
    console.log(`  Test candidates: ${result.testCandidates.length}`);
    console.log(`  Time: ${elapsed}s`);
    console.log("  Model usage:", JSON.stringify(registry.modelUsage, null, 2));
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
