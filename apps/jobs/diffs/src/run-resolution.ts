import { db } from "@autonoma/db";
import type { RunReviewVerdict } from "@autonoma/diffs";
import { FlowIndex, TestDirectory } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import type { ResolveDiffsOutput } from "@autonoma/workflow/activities";
import * as Sentry from "@sentry/node";
import { createDiffsServices } from "./create-services";
import { loadBranchData, loadFlows } from "./load-context";
import { runResolutionAgent } from "./run-resolution-agent";

export interface TestCandidateInfo {
    name: string;
    instruction: string;
    url?: string;
    reasoning: string;
}

export interface RunDiffsResolutionInput {
    branchId: string;
    runIds: string[];
    step1Reasoning: string;
    testCandidates: TestCandidateInfo[];
}

export async function runDiffsResolution(input: RunDiffsResolutionInput): Promise<ResolveDiffsOutput> {
    const { branchId, runIds, step1Reasoning, testCandidates } = input;
    const logger = rootLogger.child({ name: "runDiffsResolution", branchId });

    Sentry.setTag("branchId", branchId);
    logger.info("Starting diffs resolution", { runIds });

    const { githubApp, updater } = await createDiffsServices(branchId);

    const headSha = updater.headSha;
    const baseSha = updater.baseSha;

    if (headSha == null || baseSha == null) {
        throw new Error(
            `Pending snapshot for branch ${branchId} is missing required SHAs (headSha: ${headSha ?? "null"}, baseSha: ${baseSha ?? "null"})`,
        );
    }

    let modifiedTests = 0;
    let quarantinedTests = 0;
    let bugsTracked = 0;

    // Build verdicts from run reviews and run the resolution agent
    if (runIds.length > 0) {
        const verdicts = await buildVerdicts(runIds);

        if (verdicts.length > 0) {
            logger.info("Running resolution agent", { verdictCount: verdicts.length });

            const branchData = await loadBranchData(branchId, githubApp);
            const githubClient = await githubApp.getInstallationClient(Number(branchData.installationId));

            const repoDir = await githubClient.cloneRepository({
                fullName: branchData.fullName,
                headSha,
                baseSha,
                targetDir: "/tmp/repo-resolution",
            });

            const suiteInfo = await updater.currentTestSuiteInfo();

            const tests = suiteInfo.testCases
                .filter((tc) => tc.plan != null)
                .map((tc) => ({ id: tc.id, name: tc.name, slug: tc.slug, prompt: tc.plan!.prompt }));
            const skills = suiteInfo.skills
                .filter((s) => s.plan != null)
                .map((s) => ({
                    id: s.id,
                    name: s.name,
                    slug: s.slug,
                    description: s.description,
                    content: s.plan!.content,
                }));

            const [testDirectory, flowIndex] = await Promise.all([
                TestDirectory.create({ workingDirectory: repoDir, tests, skills }),
                loadFlows(branchData.applicationId, suiteInfo).then((flows) => new FlowIndex(flows)),
            ]);

            const agentResult = await runResolutionAgent({
                input: { verdicts, step1Reasoning, testCandidates },
                db,
                updater,
                applicationId: branchData.applicationId,
                repoDir,
                testDirectory,
                flowIndex,
                githubClient,
                repoId: branchData.repoId,
                headSha,
            });

            modifiedTests = agentResult.modifiedTests.length;
            quarantinedTests = agentResult.quarantinedTests.length;
            bugsTracked = agentResult.reportedBugs.length;
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

async function buildVerdicts(runIds: string[]): Promise<RunReviewVerdict[]> {
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

    for (const run of runs) {
        const review = run.runReview;
        const testCase = run.assignment?.testCase;

        if (run.status === "success") {
            logger.info("Run passed, no action needed", { runId: run.id, slug: testCase?.slug });
            continue;
        }

        if (review == null || review.status !== "completed") {
            logger.warn("Run has no completed review, skipping", { runId: run.id, slug: testCase?.slug });
            continue;
        }

        verdicts.push({
            runId: run.id,
            testSlug: testCase?.slug ?? "unknown",
            testName: testCase?.name ?? "Unknown",
            originalPrompt: run.assignment?.plan?.prompt ?? "",
            runStatus: run.status,
            verdict: review.verdict ?? "unknown",
            reviewReasoning: review.reasoning ?? "",
            issueTitle: review.issue?.title ?? undefined,
            issueConfidence: review.issue?.confidence ?? undefined,
            issueDescription: review.issue?.description ?? undefined,
        });
    }

    logger.info("Built verdicts", { total: runs.length, actionable: verdicts.length });

    return verdicts;
}
