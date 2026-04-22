import fs from "fs/promises";
import { db } from "@autonoma/db";
import type { RunReviewVerdict } from "@autonoma/diffs";
import { FlowIndex, TestDirectory } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import type { ResolveDiffsOutput } from "@autonoma/workflow/activities";
import * as Sentry from "@sentry/node";
import { createDiffsServices } from "./create-services";
import { loadBranchData, loadFlows, mapTestSuiteToContext } from "./load-context";
import { runResolutionAgent } from "./run-resolution-agent";

export interface TestCandidateInfo {
    name: string;
    instruction: string;
    url?: string;
    reasoning: string;
}

export interface AffectedTestInfo {
    slug: string;
    testName: string;
    reasoning: string;
}

export interface RunDiffsResolutionInput {
    snapshotId: string;
    runIds: string[];
    step1Reasoning: string;
    testCandidates: TestCandidateInfo[];
    affectedTests: AffectedTestInfo[];
}

export async function runDiffsResolution(input: RunDiffsResolutionInput): Promise<ResolveDiffsOutput> {
    const { snapshotId, runIds, step1Reasoning, testCandidates, affectedTests } = input;
    const logger = rootLogger.child({ name: "runDiffsResolution", snapshotId });

    Sentry.setTag("snapshotId", snapshotId);
    logger.info("Starting diffs resolution", {
        runIdsCount: runIds.length,
        testCandidatesCount: testCandidates.length,
        affectedTestsCount: affectedTests.length,
    });

    const { githubApp, updater } = await createDiffsServices(snapshotId);
    const branchId = updater.branchId;

    Sentry.setTag("branchId", branchId);

    const headSha = updater.headSha;
    const baseSha = updater.baseSha;

    if (headSha == null || baseSha == null) {
        throw new Error(
            `Snapshot ${snapshotId} (branch ${branchId}) is missing required SHAs (headSha: ${headSha ?? "null"}, baseSha: ${baseSha ?? "null"})`,
        );
    }

    let modifiedTests = 0;
    let quarantinedTests = 0;
    let bugsTracked = 0;

    const shouldRunAgent = runIds.length > 0 || testCandidates.length > 0;

    if (!shouldRunAgent) {
        logger.info("Resolution skipped - no runs and no candidates");
    } else {
        const { verdicts, runSlugs } = runIds.length > 0 ? await buildVerdicts(runIds) : { verdicts: [], runSlugs: [] };

        const affectedSlugs = affectedTests.map((t) => t.slug);
        const runSlugSet = new Set(runSlugs);
        const affectedButNotRun = affectedSlugs.filter((s) => !runSlugSet.has(s));

        if (affectedButNotRun.length > 0) {
            logger.warn("Affected tests did not produce runs", {
                affectedCount: affectedTests.length,
                runsCount: runSlugs.length,
                affectedButNotRun,
            });
        }

        logger.info("Running resolution agent", {
            verdictCount: verdicts.length,
            candidateCount: testCandidates.length,
            affectedCount: affectedTests.length,
            runsCount: runIds.length,
            affectedButNotRun,
        });

        const branchData = await loadBranchData(branchId, githubApp);
        const githubClient = await githubApp.getInstallationClient(Number(branchData.installationId));

        await fs.rm("/tmp/repo-resolution", { recursive: true, force: true });

        try {
            const repoDir = await githubClient.cloneRepository({
                fullName: branchData.fullName,
                headSha,
                baseSha,
                targetDir: "/tmp/repo-resolution",
            });

            const suiteInfo = await updater.currentTestSuiteInfo();
            const { existingTests, existingSkills } = mapTestSuiteToContext(suiteInfo);

            const [testDirectory, flowIndex] = await Promise.all([
                TestDirectory.create({ workingDirectory: repoDir, tests: existingTests, skills: existingSkills }),
                loadFlows(branchData.applicationId, suiteInfo).then((flows) => new FlowIndex(flows)),
            ]);

            const agentResult = await runResolutionAgent({
                input: { verdicts, step1Reasoning, testCandidates },
                db,
                updater,
                applicationId: branchData.applicationId,
                organizationId: branchData.organizationId,
                repoDir,
                testDirectory,
                flowIndex,
            });

            modifiedTests = agentResult.modifiedTests.length;
            quarantinedTests = agentResult.quarantinedTests.length;
            bugsTracked = agentResult.reportedBugs.length;
        } finally {
            await fs.rm("/tmp/repo-resolution", { recursive: true, force: true });
        }
    }

    // Gather all pending generations (from both modified tests and new tests added in Step 1)
    const pendingGens = await updater.getPendingGenerations();

    if (pendingGens.length > 0) {
        await updater.markGenerationsQueued(pendingGens.map((g) => g.testGenerationId));
    }

    const generations = pendingGens.map((gen) => ({
        testGenerationId: gen.testGenerationId,
        scenarioId: gen.scenarioId,
        architecture: gen.architecture,
    }));

    logger.info("Diffs resolution complete", {
        modifiedTests,
        quarantinedTests,
        bugsTracked,
        generations: generations.length,
    });

    return { generations, modifiedTests, quarantinedTests, bugsTracked };
}

async function buildVerdicts(runIds: string[]): Promise<{ verdicts: RunReviewVerdict[]; runSlugs: string[] }> {
    const logger = rootLogger.child({ name: "buildVerdicts" });

    const runs = await db.run.findMany({
        where: { id: { in: runIds } },
        select: {
            id: true,
            status: true,
            assignment: {
                select: {
                    testCase: { select: { name: true, slug: true } },
                    plan: { select: { prompt: true } },
                },
            },
            runReview: {
                select: {
                    status: true,
                    verdict: true,
                    reasoning: true,
                    issue: {
                        select: {
                            confidence: true,
                            title: true,
                            description: true,
                        },
                    },
                },
            },
        },
    });

    const verdicts: RunReviewVerdict[] = [];
    const runsPassed: string[] = [];
    const runsActionable: string[] = [];
    const runsWithoutReview: string[] = [];

    for (const run of runs) {
        const review = run.runReview;
        const testCase = run.assignment?.testCase;
        const slug = testCase?.slug ?? "unknown";

        if (run.status === "success") {
            logger.info("Run passed, no action needed", { runId: run.id, slug });
            runsPassed.push(slug);
            continue;
        }

        if (review == null || review.status !== "completed") {
            logger.warn("Run has no completed review, skipping", { runId: run.id, slug });
            runsWithoutReview.push(slug);
            continue;
        }

        verdicts.push({
            runId: run.id,
            testSlug: slug,
            testName: testCase?.name ?? "Unknown",
            originalPrompt: run.assignment?.plan?.prompt ?? "",
            runStatus: run.status,
            verdict: review.verdict ?? "unknown",
            reviewReasoning: review.reasoning ?? "",
            issueTitle: review.issue?.title ?? undefined,
            issueConfidence: review.issue?.confidence ?? undefined,
            issueDescription: review.issue?.description ?? undefined,
        });
        runsActionable.push(slug);
    }

    logger.info("Built verdicts", {
        total: runs.length,
        actionable: verdicts.length,
        runsPassed,
        runsActionable,
        runsWithoutReview,
    });

    const runSlugs = runs.map((r) => r.assignment?.testCase?.slug).filter((s): s is string => s != null);

    return { verdicts, runSlugs };
}
