/**
 * Run the diffs agent against a real git repository.
 *
 * Usage:
 *   pnpm tsx scripts/run-on-repo.ts <repo-path> [--model flash|glm|kimi]
 *
 * The repo must have at least 2 commits (the agent diffs HEAD~1..HEAD).
 * It reads autonoma/skills/*.md and autonoma test files to build the input.
 *
 * Example:
 *   pnpm tsx scripts/run-on-repo.ts /path/to/appium-navigator --model flash
 */

import { execSync } from "node:child_process";
import { MODEL_ENTRIES, ModelRegistry, openRouterProvider, simpleCostFunction } from "@autonoma/ai";
import type { DiffsAgentInput } from "../src/diffs-agent";
import { DiffsAgent } from "../src/diffs-agent";
import { FlowIndex } from "../src/flow-index";
import { TestDirectory } from "../src/test-directory";

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

function getRepoPath(): string {
    const path = args.find((a) => !a.startsWith("--"));
    if (path == null) {
        console.error("Usage: pnpm tsx scripts/run-on-repo.ts <repo-path> [--model=flash|glm|kimi]");
        process.exit(1);
    }
    return path;
}

const repoPath = getRepoPath();

// --- Helpers ---

function git(cwd: string, command: string): string {
    return execSync(`git ${command}`, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

// --- Main ---

async function main() {
    console.log("\n=== Diffs Agent - Real Repo Test ===");
    console.log(`Repo: ${repoPath}`);
    console.log(`Model: ${modelKey}`);
    console.log();

    // Get diff info
    const affectedFiles = git(repoPath, "diff HEAD~1 HEAD --name-only")
        .split("\n")
        .filter((f) => f.length > 0);
    const diffStat = git(repoPath, "diff HEAD~1 HEAD --stat");
    const commitMessage = git(repoPath, "log -1 --format=%s");

    console.log(`Commit: ${commitMessage}`);
    console.log(`Affected files: ${affectedFiles.length}`);
    console.log(diffStat);
    console.log();

    // Read skills and tests
    const testDirectory = await TestDirectory.load(repoPath);
    const existingSkills = await testDirectory.readSkills();
    const existingTests = await testDirectory.readTests();

    // Build input
    const input: DiffsAgentInput = {
        analysis: {
            affectedFiles,
            summary: commitMessage,
        },
        existingTests,
        existingSkills,
    };

    // Create model
    const registry = new ModelRegistry({ models: MODEL_OPTIONS });
    const model = registry.getModel({ model: modelKey, tag: "diffs-script" });

    // Run agent
    console.log("--- Starting agent ---\n");
    const startTime = Date.now();

    // Build flow index from test directory (no DB in scripts, so empty flows)
    const flowIndex = new FlowIndex([]);

    const agent = new DiffsAgent({
        model,
        workingDirectory: repoPath,
        flowIndex,
        testDirectory,
        maxSteps: 60,
    });

    const result = await agent.analyze(input);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Print report
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

    // Summary
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
