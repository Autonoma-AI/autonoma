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
import type { DiffsAgentCallbacks } from "../src/callbacks";
import type { DiffsAgentInput, TestRunResult } from "../src/diffs-agent";
import { DiffsAgent } from "../src/diffs-agent";
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

// --- Mock callbacks (log-only for real repo testing) ---

function createLoggingCallbacks(): DiffsAgentCallbacks & { calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = {
        triggerTestAndWait: [],
        quarantineTest: [],
        modifyTest: [],
        updateSkill: [],
        reportBug: [],
    };

    return {
        calls,
        triggerTestAndWait: async (slug) => {
            calls.triggerTestAndWait.push(slug);
            console.log(`  [RUN TEST] ${slug}`);
            // Simulate a failed test - the agent should read the diff to understand why
            const result: TestRunResult = {
                slug,
                testName: slug,
                success: false,
                finishReason: "success",
                reasoning:
                    "Test failed because the UI element or navigation path described in the test instructions " +
                    "could not be found. The page structure appears to have changed.",
                stepDescriptions: [
                    "Attempted to follow test instructions",
                    "Could not find expected UI element or navigation path",
                    "Test failed due to UI changes",
                ],
                screenshotUrls: [],
            };
            return result;
        },
        quarantineTest: async (slug) => {
            calls.quarantineTest.push(slug);
            console.log(`  [QUARANTINE] ${slug}`);
        },
        modifyTest: async (slug, newInstruction) => {
            calls.modifyTest.push({ slug, newInstruction });
            console.log(`  [MODIFY] ${slug}`);
            console.log(`    New instruction: ${newInstruction.slice(0, 200)}...`);
        },
        updateSkill: async (skillId, newContent) => {
            calls.updateSkill.push({ skillId, newContent });
            console.log(`  [UPDATE SKILL] ${skillId}`);
            console.log(`    New content: ${newContent.slice(0, 200)}...`);
        },
        reportBug: async (report) => {
            calls.reportBug.push(report);
            console.log(`  [BUG FOUND] ${report.summary}`);
            console.log(`    Files: ${report.affectedFiles.join(", ")}`);
        },
    };
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

    // Create callbacks
    const callbacks = createLoggingCallbacks();

    // Run agent
    console.log("--- Starting agent ---\n");
    const startTime = Date.now();

    const agent = new DiffsAgent({
        model,
        workingDirectory: repoPath,
        callbacks,
        maxSteps: 60,
    });

    const result = await agent.analyze(input);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Print report
    console.log(`\n\n=== RESULTS (${elapsed}s) ===\n`);

    console.log(`Reasoning: ${result.reasoning}\n`);

    if (result.testActions.length > 0) {
        console.log(`--- Test Actions (${result.testActions.length}) ---`);
        for (const action of result.testActions) {
            if (action.type === "quarantine") {
                console.log(`  QUARANTINE: ${action.slug} - ${action.reasoning}`);
            } else {
                console.log(`  MODIFY: ${action.slug} - ${action.reasoning}`);
                console.log(`    New instruction: ${action.newInstruction.slice(0, 200)}...`);
            }
        }
        console.log();
    }

    if (result.bugReports.length > 0) {
        console.log(`--- Bug Reports (${result.bugReports.length}) ---`);
        for (const bug of result.bugReports) {
            console.log(`  BUG: ${bug.summary}`);
            console.log(`    Test: ${bug.slug}`);
            console.log(`    Files: ${bug.affectedFiles.join(", ")}`);
            console.log(`    Fix: ${bug.fixPrompt.slice(0, 300)}...`);
        }
        console.log();
    }

    if (result.skillUpdates.length > 0) {
        console.log(`--- Skill Updates (${result.skillUpdates.length}) ---`);
        for (const update of result.skillUpdates) {
            console.log(`  UPDATE: ${update.skillId} (${update.skillName})`);
            console.log(`    Reason: ${update.reasoning}`);
        }
        console.log();
    }

    if (result.newTests.length > 0) {
        console.log(`--- New Tests (${result.newTests.length}) ---`);
        for (const test of result.newTests) {
            console.log(`  NEW: ${test.name}`);
            console.log(`    Reason: ${test.reasoning}`);
            console.log(`    Instruction: ${test.instruction.slice(0, 200)}...`);
        }
        console.log();
    }

    // Summary
    console.log("--- Summary ---");
    console.log(`  Tests run: ${callbacks.calls.triggerTestAndWait.length}`);
    console.log(`  Tests quarantined: ${result.testActions.filter((a) => a.type === "quarantine").length}`);
    console.log(`  Tests modified: ${result.testActions.filter((a) => a.type === "modify").length}`);
    console.log(`  Bugs found: ${result.bugReports.length}`);
    console.log(`  Skills updated: ${result.skillUpdates.length}`);
    console.log(`  New tests suggested: ${result.newTests.length}`);
    console.log(`  Time: ${elapsed}s`);
    console.log("  Model usage:", JSON.stringify(registry.modelUsage, null, 2));
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
