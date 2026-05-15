import fs from "fs/promises";
import { db } from "@autonoma/db";
import type { RunReviewVerdict, TestCandidateInput } from "@autonoma/diffs";
import { FlowIndex } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import * as Sentry from "@sentry/node";
import type { ModelMessage } from "ai";
import { createDiffsServices } from "./create-services";
import { loadBranchData, loadFlows, mapTestSuiteToContext } from "./load-context";
import { type AcceptedCandidateLink, runResolutionAgent } from "./run-resolution-agent";
import { uploadConversation } from "./upload-conversation";

export async function runDiffsResolution(snapshotId: string): Promise<void> {
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
                testCase: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                        assignments: {
                            where: { snapshotId },
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
        candidateId: c.id,
        name: c.name,
        instruction: c.instruction,
        reasoning: c.reasoning,
    }));

    const shouldRunAgent = runIdsCount > 0 || candidateInputs.length > 0;

    let resolutionReasoning = "";
    let modifiedSlugs: string[] = [];
    let newTestsCount = 0;
    let acceptedCandidates: AcceptedCandidateLink[] = [];
    let resolutionConversation: ModelMessage[] = [];

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

            const flows = await loadFlows(branchData.applicationId, suiteInfo);
            const flowIndex = new FlowIndex(flows);

            const agentResult = await runResolutionAgent({
                input: {
                    verdicts,
                    step1Reasoning: diffsJob.analysisReasoning ?? "",
                    testCandidates: candidateInputs,
                    existingTests,
                    existingSkills,
                },
                db,
                updater,
                repoDir,
                flowIndex,
            });

            resolutionReasoning = agentResult.reasoning;
            modifiedSlugs = agentResult.modifiedTests.map((t) => t.slug);
            newTestsCount = agentResult.newTests.length;
            acceptedCandidates = agentResult.accepted;
            resolutionConversation = agentResult.conversation;
        } finally {
            await fs.rm("/tmp/repo-resolution", { recursive: true, force: true });
        }
    }

    await linkResolutionOutcomes({
        snapshotId,
        modifiedSlugs,
        accepted: acceptedCandidates,
        logger,
    });

    const resolutionConversationUrl = await uploadConversation({
        storage: S3Storage.createFromEnv(),
        snapshotId,
        phase: "resolution",
        conversation: resolutionConversation,
        logger,
    });

    await db.diffsJob.update({
        where: { snapshotId },
        data: { resolutionReasoning, resolutionConversationUrl, status: "generating" },
    });

    logger.info("Diffs resolution complete", {
        modifiedTests: modifiedSlugs.length,
        newTests: newTestsCount,
        acceptedCandidates: acceptedCandidates.length,
    });
}

type AffectedTestWithRun = {
    testCaseId: string;
    affectedReason: "code_change" | "merge_plan_imported" | "merge_conflict";
    runId: string | null;
    testCase: {
        id: string;
        name: string;
        slug: string;
        assignments: { quarantineIssueId: string | null }[];
    };
    run: {
        id: string;
        status: string;
        assignment: { plan: { prompt: string } | null } | null;
        runReview: {
            status: string;
            verdict: string | null;
            reasoning: string | null;
            issue: { title: string; description: string } | null;
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
    const runsQuarantined: string[] = [];

    for (const affected of affectedTests) {
        const run = affected.run;
        if (run == null) continue;

        const slug = affected.testCase.slug;

        if (affected.testCase.assignments[0]?.quarantineIssueId != null) {
            runsQuarantined.push(slug);
            continue;
        }

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
        runsQuarantined,
    });

    return verdicts;
}

interface LinkResolutionOutcomesParams {
    snapshotId: string;
    modifiedSlugs: string[];
    accepted: AcceptedCandidateLink[];
    logger: ReturnType<typeof rootLogger.child>;
}

async function linkResolutionOutcomes({
    snapshotId,
    modifiedSlugs,
    accepted,
    logger,
}: LinkResolutionOutcomesParams): Promise<void> {
    if (modifiedSlugs.length > 0) {
        await linkModifiedToGenerations(snapshotId, modifiedSlugs, logger);
    }

    await reconcileTestCandidates(snapshotId, accepted, logger);
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

async function reconcileTestCandidates(
    snapshotId: string,
    accepted: AcceptedCandidateLink[],
    logger: ReturnType<typeof rootLogger.child>,
): Promise<void> {
    if (accepted.length === 0) {
        logger.info("No new test candidates accepted");
        await db.testCandidate.updateMany({
            where: { snapshotId, status: "pending" },
            data: { status: "rejected" },
        });
        return;
    }

    const ids = accepted.map((a) => a.candidateId);
    const candidates = await db.testCandidate.findMany({
        where: { snapshotId, id: { in: ids } },
        select: { id: true },
    });
    const validIds = new Set(candidates.map((c) => c.id));

    const missing = accepted.filter((a) => !validIds.has(a.candidateId));
    if (missing.length > 0) {
        logger.warn("Accepted candidate ids not found in this snapshot", {
            missingCandidateIds: missing.map((m) => m.candidateId),
        });
    }

    await Promise.all(
        accepted
            .filter((a) => validIds.has(a.candidateId))
            .map((a) =>
                db.testCandidate
                    .update({
                        where: { id: a.candidateId },
                        data: { status: "accepted", acceptedTestCaseId: a.testCaseId },
                    })
                    .catch((error) => {
                        logger.warn("Failed to mark candidate accepted", {
                            candidateId: a.candidateId,
                            error,
                        });
                    }),
            ),
    );

    await db.testCandidate.updateMany({
        where: { snapshotId, status: "pending" },
        data: { status: "rejected" },
    });
}
