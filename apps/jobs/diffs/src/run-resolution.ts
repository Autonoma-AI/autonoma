import fs from "fs/promises";
import { db } from "@autonoma/db";
import type { GeneratedTest, RunReviewVerdict, TestCandidateInput } from "@autonoma/diffs";
import { FlowIndex, TestDirectory } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import type { ResolveDiffsOutput } from "@autonoma/workflow/activities";
import * as Sentry from "@sentry/node";
import { createDiffsServices } from "./create-services";
import { loadBranchData, loadFlows, mapTestSuiteToContext } from "./load-context";
import { runResolutionAgent } from "./run-resolution-agent";

export async function runDiffsResolution(snapshotId: string): Promise<ResolveDiffsOutput> {
    const logger = rootLogger.child({ name: "runDiffsResolution", snapshotId });

    Sentry.setTag("snapshotId", snapshotId);

    const diffsJob = await db.diffsJob.findUniqueOrThrow({
        where: { snapshotId },
        select: { analysisReasoning: true },
    });

    const [affectedTests, testCandidates] = await Promise.all([
        db.affectedTest.findMany({
            where: { snapshotId },
            select: {
                snapshotId: true,
                testCaseId: true,
                affectedReason: true,
                runId: true,
                testCase: { select: { id: true, name: true, slug: true } },
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
                                issue: { select: { confidence: true, title: true, description: true } },
                            },
                        },
                    },
                },
            },
        }),
        db.testCandidate.findMany({
            where: { snapshotId },
            select: { id: true, name: true, instruction: true, reasoning: true },
        }),
    ]);

    const runIdsCount = affectedTests.filter((t) => t.runId != null).length;
    logger.info("Loaded resolution inputs", {
        affectedTestsCount: affectedTests.length,
        runIdsCount,
        testCandidatesCount: testCandidates.length,
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

    const candidateInputs: TestCandidateInput[] = testCandidates.map((c) => ({
        name: c.name,
        instruction: c.instruction,
        reasoning: c.reasoning,
    }));

    const shouldRunAgent = runIdsCount > 0 || candidateInputs.length > 0;

    let resolutionReasoning = "";
    let modifiedSlugs: string[] = [];
    let newTestNames: GeneratedTest[] = [];

    if (!shouldRunAgent) {
        logger.info("Resolution skipped - no runs and no candidates");
    } else {
        const verdicts = buildVerdicts(affectedTests, logger);

        logger.info("Running resolution agent", {
            verdictCount: verdicts.length,
            candidateCount: candidateInputs.length,
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
                input: {
                    verdicts,
                    step1Reasoning: diffsJob.analysisReasoning ?? "",
                    testCandidates: candidateInputs,
                },
                db,
                updater,
                applicationId: branchData.applicationId,
                organizationId: branchData.organizationId,
                repoDir,
                testDirectory,
                flowIndex,
            });

            resolutionReasoning = agentResult.reasoning;
            modifiedSlugs = agentResult.modifiedTests.map((t) => t.slug);
            newTestNames = agentResult.newTests;
        } finally {
            await fs.rm("/tmp/repo-resolution", { recursive: true, force: true });
        }
    }

    // Gather all pending generations (from both modified tests and new tests added in Step 1)
    const pendingGens = await updater.getPendingGenerations();

    if (pendingGens.length > 0) {
        await updater.markGenerationsQueued(pendingGens.map((g) => g.testGenerationId));
    }

    await linkResolutionOutcomes({
        snapshotId,
        modifiedSlugs,
        newTestNames: newTestNames.map((t) => t.name),
        logger,
    });

    await db.diffsJob.update({
        where: { snapshotId },
        data: { resolutionReasoning, status: "generating" },
    });

    const generations = pendingGens.map((gen) => ({
        testGenerationId: gen.testGenerationId,
        scenarioId: gen.scenarioId,
        architecture: gen.architecture,
    }));

    logger.info("Diffs resolution complete", {
        modifiedTests: modifiedSlugs.length,
        newTests: newTestNames.length,
        generations: generations.length,
    });

    return { generations };
}

type AffectedTestWithRun = {
    testCaseId: string;
    affectedReason: "code_change" | "merge_plan_imported" | "merge_conflict";
    runId: string | null;
    testCase: { id: string; name: string; slug: string };
    run: {
        id: string;
        status: string;
        assignment: { plan: { prompt: string } | null } | null;
        runReview: {
            status: string;
            verdict: string | null;
            reasoning: string | null;
            issue: { confidence: number; title: string; description: string } | null;
        } | null;
    } | null;
};

function buildVerdicts(
    affectedTests: AffectedTestWithRun[],
    logger: ReturnType<typeof rootLogger.child>,
): RunReviewVerdict[] {
    const verdicts: RunReviewVerdict[] = [];
    const runsPassed: string[] = [];
    const runsActionable: string[] = [];
    const runsWithoutReview: string[] = [];

    for (const affected of affectedTests) {
        const run = affected.run;
        if (run == null) continue;

        const slug = affected.testCase.slug;

        if (run.status === "success") {
            runsPassed.push(slug);
            continue;
        }

        const review = run.runReview;
        if (review == null || review.status !== "completed") {
            runsWithoutReview.push(slug);
            continue;
        }

        verdicts.push({
            runId: run.id,
            testSlug: slug,
            testName: affected.testCase.name,
            originalPrompt: run.assignment?.plan?.prompt ?? "",
            runStatus: run.status,
            verdict: review.verdict ?? "unknown",
            reviewReasoning: review.reasoning ?? "",
            issueTitle: review.issue?.title ?? undefined,
            issueConfidence: review.issue?.confidence ?? undefined,
            issueDescription: review.issue?.description ?? undefined,
            affectedReason: affected.affectedReason,
        });
        runsActionable.push(slug);
    }

    logger.info("Built verdicts", {
        actionable: verdicts.length,
        runsPassed,
        runsActionable,
        runsWithoutReview,
    });

    return verdicts;
}

interface LinkResolutionOutcomesParams {
    snapshotId: string;
    modifiedSlugs: string[];
    newTestNames: string[];
    logger: ReturnType<typeof rootLogger.child>;
}

async function linkResolutionOutcomes({
    snapshotId,
    modifiedSlugs,
    newTestNames,
    logger,
}: LinkResolutionOutcomesParams): Promise<void> {
    if (modifiedSlugs.length > 0) {
        await linkModifiedToGenerations(snapshotId, modifiedSlugs, logger);
    }

    await reconcileTestCandidates(snapshotId, newTestNames, logger);
}

async function linkModifiedToGenerations(
    snapshotId: string,
    slugs: string[],
    logger: ReturnType<typeof rootLogger.child>,
): Promise<void> {
    const generations = await db.testGeneration.findMany({
        where: {
            snapshotId,
            testPlan: { testCase: { slug: { in: slugs } } },
        },
        select: { id: true, testPlan: { select: { testCase: { select: { id: true, slug: true } } } } },
    });

    const latestByTestCase = new Map<string, string>();
    for (const gen of generations) {
        latestByTestCase.set(gen.testPlan.testCase.id, gen.id);
    }

    for (const [testCaseId, generationId] of latestByTestCase) {
        await db.affectedTest
            .update({
                where: { snapshotId_testCaseId: { snapshotId, testCaseId } },
                data: { generationId },
            })
            .catch((error) => {
                logger.warn("Failed to link AffectedTest to generation", { testCaseId, generationId, error });
            });
    }
}

export class CandidateNotFoundError extends Error {
    constructor(public readonly missingNames: string[]) {
        super(`Test candidates with names "${missingNames.join('", "')}" not found in database`);
    }
}

async function reconcileTestCandidates(
    snapshotId: string,
    acceptedNames: string[],
    logger: ReturnType<typeof rootLogger.child>,
): Promise<void> {
    if (acceptedNames.length === 0) {
        logger.info("No new test candidates accepted");
        return;
    }

    const candidates = await db.testCandidate.findMany({
        where: { snapshotId, name: { in: acceptedNames } },
        select: { id: true, name: true, snapshotId: true, organizationId: true },
    });

    if (candidates.length !== acceptedNames.length) {
        logger.fatal("Mismatch between accepted candidate names and database entries", {
            acceptedNames,
            foundCandidates: candidates.map((c) => c.name),
        });
        throw new CandidateNotFoundError(acceptedNames.filter((name) => !candidates.some((c) => c.name === name)));
    }

    const orgId = candidates[0]!.organizationId;
    const newTestCases = await db.testCase.findMany({
        where: {
            name: { in: acceptedNames },
            organizationId: orgId,
            assignments: { some: { snapshotId } },
        },
        select: { id: true, name: true },
    });
    const testCaseIdByName = new Map(newTestCases.map((tc) => [tc.name, tc.id]));

    await Promise.all(
        candidates.map(async (candidate) =>
            db.testCandidate
                .update({
                    where: { id: candidate.id },
                    data: { status: "accepted", acceptedTestCaseId: testCaseIdByName.get(candidate.name) },
                })
                .catch((error) => {
                    logger.warn("Failed to mark candidate accepted", { candidateId: candidate.id, error });
                }),
        ),
    );

    await db.testCandidate.updateMany({
        where: { snapshotId, status: "pending" },
        data: { status: "rejected" },
    });
}
