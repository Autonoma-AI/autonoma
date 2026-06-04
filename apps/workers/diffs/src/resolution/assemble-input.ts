import { db } from "@autonoma/db";
import {
    FlowIndex,
    type ResolutionAgentInput,
    type RunReviewVerdict,
    ScenarioIndex,
    type ScenarioInfo,
    type TestCandidateInput,
    buildVerdicts,
    loadFlows,
    mapTestSuiteToContext,
} from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { fetchTestSuiteInfo } from "@autonoma/test-updates";
import type { TestSuiteSource } from "../analysis/assemble-input";
import { type BranchData, loadBranchData } from "../analysis/load-context";
import { createGithubApp } from "../create-services";

const logger = rootLogger.child({ name: "assembleResolutionAgentInput" });

/** The ResolutionAgent input minus the on-disk clone, which the caller owns. */
export type ResolutionAgentInputWithoutCodebase = Omit<ResolutionAgentInput, "codebase">;

export interface AssembledResolutionAgentInput {
    /** Everything the {@link ResolutionAgent} needs except the codebase clone. */
    agentInput: ResolutionAgentInputWithoutCodebase;
    /** Branch/application/org context, needed downstream for persistence. */
    branchData: BranchData;
}

export interface AssembleResolutionAgentInputParams {
    snapshotId: string;
    /**
     * Which snapshot to read the *baseline state* from: the suite
     * (`existingTests`) and the per-test quarantine gate consumed by
     * {@link buildVerdicts}. Defaults to `"current"` (correct + cheap at
     * production runtime). Capture passes `"previous"` to recover what
     * resolution actually saw after the pipeline has mutated this snapshot's
     * assignments. See {@link TestSuiteSource}.
     */
    testSuiteSource?: TestSuiteSource;
}

/**
 * Loads and assembles the full {@link ResolutionAgentInput} (minus the codebase)
 * for a snapshot: branch data, suite/flow/scenario context, run-review verdicts,
 * and the snapshot's test candidates.
 *
 * Shared between the production resolution runner and the eval-capture utility -
 * capture freezes the assembled input to disk, the runner feeds it straight to
 * the agent. Keeping it in one place guarantees the captured fixture matches
 * what production actually runs.
 *
 * **Baseline state.** Resolution acts on the snapshot's assignments as they
 * stood *before* its callbacks ran - `modifyTest` rewrites plans, `removeTest`
 * deletes assignments, and `reportBug` quarantines tests. At production
 * runtime those mutations haven't happened yet, so reading the current
 * snapshot ("current") gives the baseline. At capture time they have, so
 * capture reads the previous snapshot ("previous") to recover the same
 * baseline. The switch affects two fields: `existingTests` (the suite) and
 * the quarantine flag that {@link buildVerdicts} uses to filter out runs -
 * both must travel together, otherwise capture would silently drop the
 * verdicts that resolution itself quarantined.
 *
 * **Test candidates.** At production time candidates have `status: "pending"`;
 * after resolution they are either "accepted" or "rejected". Capture must read
 * all statuses to recover the original inputs the agent received - the
 * candidate id/name/instruction/reasoning fields are immutable.
 */
export async function assembleResolutionAgentInput({
    snapshotId,
    testSuiteSource = "current",
}: AssembleResolutionAgentInputParams): Promise<AssembledResolutionAgentInput> {
    logger.info("Assembling resolution agent input", { extra: { snapshotId, testSuiteSource } });

    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { branchId: true, prevSnapshotId: true },
    });
    const { branchId, prevSnapshotId } = snapshot;

    const githubApp = createGithubApp();
    const branchData = await loadBranchData(branchId, githubApp);
    logger.info("Loaded branch data", { extra: { fullName: branchData.fullName } });

    const baselineSnapshotId = resolveBaselineSnapshotId(snapshotId, prevSnapshotId, testSuiteSource);
    const suiteInfo = await fetchTestSuiteInfo(db, baselineSnapshotId);

    const { existingTests } = mapTestSuiteToContext(suiteInfo);

    const [flows, application, scenarios] = await Promise.all([
        loadFlows(db, branchData.applicationId, suiteInfo),
        db.application.findUniqueOrThrow({
            where: { id: branchData.applicationId },
            select: { testScopeGuidelines: true },
        }),
        loadScenarios(branchData.applicationId),
    ]);

    const flowIndex = new FlowIndex(flows);
    const scenarioIndex = new ScenarioIndex(scenarios);

    const { verdicts, step1Reasoning, testCandidates } = await loadResolutionRuntimeInputs(
        snapshotId,
        baselineSnapshotId,
    );

    logger.info("Loaded resolution context", {
        extra: {
            existingTests: existingTests.length,
            flows: flows.length,
            scenarios: scenarios.length,
            verdicts: verdicts.length,
            testCandidates: testCandidates.length,
            hasTestScopeGuidelines: application.testScopeGuidelines != null,
        },
    });

    const agentInput: ResolutionAgentInputWithoutCodebase = {
        flowIndex,
        scenarioIndex,
        existingTests,
        verdicts,
        step1Reasoning,
        testCandidates,
        testScopeGuidelines: application.testScopeGuidelines ?? undefined,
    };

    return { agentInput, branchData };
}

/**
 * Resolve which snapshot's *baseline state* resolution should be read from -
 * its suite (`existingTests`), and per-test gates that depend on snapshot-scoped
 * assignment state (most importantly, quarantine flags consumed by
 * {@link buildVerdicts}).
 *
 * See {@link assembleResolutionAgentInput} for the "current" vs "previous"
 * reasoning - the same rule applies to every field that resolution would have
 * mutated by capture time, not just `existingTests`. Falls back to the current
 * snapshot when there is no previous snapshot (a genesis snapshot has no
 * baseline to recover).
 */
function resolveBaselineSnapshotId(snapshotId: string, prevSnapshotId: string | null, source: TestSuiteSource): string {
    if (source === "current") return snapshotId;

    if (prevSnapshotId == null) {
        logger.warn("Snapshot has no previous snapshot; falling back to its own state as the baseline", {
            extra: { snapshotId },
        });
        return snapshotId;
    }

    logger.info("Using previous snapshot's state as the resolution baseline", {
        extra: { snapshotId, prevSnapshotId },
    });
    return prevSnapshotId;
}

/** Load the active, non-disabled scenarios for an application as {@link ScenarioInfo}. */
async function loadScenarios(applicationId: string): Promise<ScenarioInfo[]> {
    const scenarios = await db.scenario.findMany({
        where: { applicationId, isDisabled: false },
        select: {
            id: true,
            name: true,
            description: true,
            activeRecipeVersion: {
                select: { fingerprint: true, fixtureJson: true, validationStatus: true },
            },
            instances: {
                where: { status: "UP_SUCCESS" },
                orderBy: { upAt: "desc" },
                take: 3,
                select: { metadata: true },
            },
        },
    });

    return scenarios.map((s) => {
        const sample = s.instances.find((i) => i.metadata != null);
        return {
            id: s.id,
            name: s.name,
            description: s.description ?? undefined,
            activeRecipe:
                s.activeRecipeVersion != null
                    ? {
                          fingerprint: s.activeRecipeVersion.fingerprint,
                          fixtureJson: s.activeRecipeVersion.fixtureJson,
                          validationStatus: s.activeRecipeVersion.validationStatus,
                      }
                    : undefined,
            sampleMetadata: sample?.metadata ?? undefined,
        };
    });
}

interface ResolutionRuntimeInputs {
    verdicts: RunReviewVerdict[];
    step1Reasoning: string;
    testCandidates: TestCandidateInput[];
}

/**
 * Loads everything keyed to the snapshot's *pipeline state* (not its suite):
 * the verdicts derived from affectedTest + run + review, the analysis reasoning
 * from the DiffsJob, and the candidates. Candidates are read regardless of
 * status (pending/accepted/rejected) so capture can recover the input shape
 * after the pipeline has run.
 *
 * The `baselineSnapshotId` parameter controls the snapshot that quarantine flags
 * are read from. It usually equals `snapshotId` (production: nothing has mutated
 * yet) but switches to the previous snapshot at capture time, because resolution
 * itself quarantines tests via `reportBug` - so reading the current snapshot's
 * assignments would let `buildVerdicts` filter out exactly the verdicts that
 * drove those bug-reports.
 */
async function loadResolutionRuntimeInputs(
    snapshotId: string,
    baselineSnapshotId: string,
): Promise<ResolutionRuntimeInputs> {
    const [diffsJob, affectedTests, testCandidates] = await Promise.all([
        db.diffsJob.findUniqueOrThrow({
            where: { snapshotId },
            select: { analysisReasoning: true },
        }),
        db.affectedTest.findMany({
            where: { snapshotId },
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
                            where: { snapshotId: baselineSnapshotId },
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

    const verdicts = buildVerdicts(affectedTests, logger);

    const candidateInputs: TestCandidateInput[] = testCandidates.map((c) => ({
        candidateId: c.id,
        name: c.name,
        instruction: c.instruction,
        reasoning: c.reasoning,
    }));

    return {
        verdicts,
        step1Reasoning: diffsJob.analysisReasoning ?? "",
        testCandidates: candidateInputs,
    };
}
