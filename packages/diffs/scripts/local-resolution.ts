/**
 * Run the resolution agent against a real git repository, sourcing every
 * input (verdicts, candidates, Step 1 reasoning, tests, skills, flows) from
 * the database for a given snapshot. Mirrors {@link runDiffsResolution} but
 * skips the GitHub clone, all DB writes, and S3 conversation upload.
 *
 * Usage:
 *   pnpm local-resolution <repo-path> --snapshot=<snapshotId> [--model=flash|glm|kimi]
 *
 * The repo must already be checked out locally at the snapshot's headSha.
 *
 * Example:
 *   pnpm local-resolution /path/to/horizon --snapshot=snap_123 --model=flash
 */

import { MODEL_ENTRIES, ModelRegistry, openRouterProvider, simpleCostFunction } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { fetchTestSuiteInfo } from "@autonoma/test-updates";
import {
    FlowIndex,
    type AffectedTestWithRun,
    buildVerdicts,
    loadFlows,
    mapTestSuiteToContext,
    runResolutionAgentLocally,
    type LocalTestCandidateInput,
} from "../src";

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
    console.error("Usage: pnpm local-resolution <repo-path> --snapshot=<snapshotId> [--model=flash|glm|kimi]");
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

async function loadAffectedTests(snapId: string): Promise<AffectedTestWithRun[]> {
    return db.affectedTest.findMany({
        where: { snapshotId: snapId },
        select: {
            testCaseId: true,
            affectedReason: true,
            runId: true,
            testCase: {
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    assignments: {
                        where: { snapshotId: snapId },
                        select: { quarantineIssueId: true },
                    },
                },
            },
            run: {
                select: {
                    id: true,
                    status: true,
                    assignment: { select: { plan: { select: { prompt: true } } } },
                    runReview: {
                        select: {
                            status: true,
                            verdict: true,
                            reasoning: true,
                            issue: { select: { title: true, description: true } },
                        },
                    },
                },
            },
        },
    });
}

// --- Main ---

async function main() {
    const logger = rootLogger.child({ name: "local-resolution", snapshotId: snapshotId! });

    console.log("\n=== Resolution Agent - Real Repo Test ===");
    console.log(`Repo: ${repoPath}`);
    console.log(`Snapshot: ${snapshotId}`);
    console.log(`Model: ${modelKey}`);
    console.log();

    const diffsJob = await db.diffsJob.findUniqueOrThrow({
        where: { snapshotId: snapshotId! },
        select: { analysisReasoning: true },
    });

    const [applicationId, affectedTests, testCandidates, suiteInfo] = await Promise.all([
        resolveApplicationId(snapshotId!),
        loadAffectedTests(snapshotId!),
        db.testCandidate.findMany({
            where: { snapshotId: snapshotId! },
            select: { id: true, name: true, instruction: true, reasoning: true },
        }),
        fetchTestSuiteInfo(db, snapshotId!),
    ]);

    const candidateInputs: LocalTestCandidateInput[] = testCandidates.map((c) => ({
        candidateId: c.id,
        name: c.name,
        instruction: c.instruction,
        reasoning: c.reasoning,
    }));

    const verdicts = buildVerdicts(affectedTests, logger);

    const runIdsCount = affectedTests.filter((t) => t.runId != null).length;
    if (verdicts.length === 0 && candidateInputs.length === 0) {
        console.log("Nothing to resolve: 0 actionable verdicts and 0 test candidates.");
        console.log(`(loaded ${affectedTests.length} affected tests, ${runIdsCount} with runIds)`);
        return;
    }

    const { existingTests, existingSkills } = mapTestSuiteToContext(suiteInfo);
    const flows = await loadFlows(db, applicationId, suiteInfo);
    const flowIndex = new FlowIndex(flows);

    console.log(`Loaded ${existingTests.length} tests, ${existingSkills.length} skills, ${flows.length} flows`);
    console.log(`Resolution inputs: ${verdicts.length} verdicts, ${candidateInputs.length} candidates`);
    console.log();

    const registry = new ModelRegistry({ models: MODEL_OPTIONS });
    const model = registry.getModel({ model: modelKey, tag: "resolution-script" });

    console.log("--- Starting agent ---\n");
    const startTime = Date.now();

    const result = await runResolutionAgentLocally({
        model,
        repoDir: repoPath,
        existingTests,
        existingSkills,
        verdicts,
        step1Reasoning: diffsJob.analysisReasoning ?? "",
        testCandidates: candidateInputs,
        flowIndex,
        maxSteps: 60,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n\n=== RESULTS (${elapsed}s) ===\n`);
    console.log(`Reasoning: ${result.reasoning}\n`);

    if (result.modifiedTests.length > 0) {
        console.log(`--- Modified Tests (${result.modifiedTests.length}) ---`);
        for (const t of result.modifiedTests) {
            console.log(`  MODIFIED: ${t.slug}`);
            console.log(`    Reasoning: ${t.reasoning}`);
        }
        console.log();
    }

    if (result.removedTests.length > 0) {
        console.log(`--- Removed Tests (${result.removedTests.length}) ---`);
        for (const t of result.removedTests) {
            console.log(`  REMOVED: ${t.slug}`);
            console.log(`    Reasoning: ${t.reasoning}`);
        }
        console.log();
    }

    if (result.reportedBugs.length > 0) {
        console.log(`--- Reported Bugs (${result.reportedBugs.length}) ---`);
        for (const b of result.reportedBugs) {
            console.log(`  BUG: ${b.summary}`);
            console.log(`    On test: ${b.slug} (run ${b.runId})`);
            console.log(`    Details: ${b.details.slice(0, 200)}...`);
            console.log(`    Affected files: ${b.affectedFiles.join(", ")}`);
        }
        console.log();
    }

    if (result.newTests.length > 0) {
        console.log(`--- New Tests (${result.newTests.length}) ---`);
        for (const t of result.newTests) {
            console.log(`  NEW: ${t.name} (folder: ${t.folderName})`);
            console.log(`    Accepting candidate: ${t.acceptingCandidateId ?? "<none>"}`);
            console.log(`    Scenario: ${t.scenarioId ?? "<none>"}`);
            console.log(`    Instruction: ${t.instruction.slice(0, 200)}...`);
        }
        console.log();
    }

    console.log("--- Summary ---");
    console.log(`  Modified: ${result.modifiedTests.length}`);
    console.log(`  Removed: ${result.removedTests.length}`);
    console.log(`  Reported bugs: ${result.reportedBugs.length}`);
    console.log(`  New tests: ${result.newTests.length}`);
    console.log(`  Time: ${elapsed}s`);
    console.log("  Model usage:", JSON.stringify(registry.modelUsage, null, 2));
}

main()
    .catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
    })
    .finally(() => db.$disconnect());
