import { db } from "@autonoma/db";
import { type Codebase, resolveScenarioRecipesForSnapshot } from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { AddTest, RegenerateSteps, TestSuiteUpdater, fetchTestSuiteInfo } from "@autonoma/test-updates";
import type { AnalysisTestOrigin } from "@autonoma/types";
import type { AnalysisInvestigationTarget } from "@autonoma/workflow/activities";
import { createGithubApp } from "../create-services";
import { loadBranchData, loadDiffsContext } from "./load-context";
import { runDiffsAgent } from "./run-diffs-agent";

/**
 * Why a newly-authored test is in the run set - passed to the classifier as context. The DiffsAgent authors it
 * as a COMPLETE plan for functionality this PR adds, so the run confirms the app supports the scenario it covers.
 */
const NEW_TEST_REASON =
    "New test authored by Impact Analysis for functionality this PR adds - run it to confirm the app supports the scenario it covers.";

export interface SelectImpactTargetsParams {
    /** The job's own detached snapshot the pipeline operates on. */
    snapshotId: string;
    /** The on-disk clone at base + head SHAs, owned by the activity. */
    codebase: Codebase;
}

/**
 * The Impact Analysis stage of the merged pipeline: reuse the DiffsAgent (the same stateless selection the diffs
 * job runs - diff + current suite, no prior-run history, no carry-forward) to mark affected tests and author
 * brand-new ones, then materialize every target through the canonical update actions on the job's OWN detached
 * snapshot - `AddTest` for a new test (test case + plan + assignment), `RegenerateSteps` for an affected test.
 * Each action queues one pending generation; new and affected tests then enter the Investigator fan-out
 * identically (both are assignments the Investigator cannot tell apart). The generations are NOT batch-fired -
 * each Investigator fires its own by id (epic invariant 2) - and the snapshot is never promoted (it is hidden by
 * being detached, not by leaving rows unassigned). The merge flow (main-branch import + deletion propagation) is
 * a separate slice (#1515) and is deliberately not run here.
 */
export async function selectImpactTargets({
    snapshotId,
    codebase,
}: SelectImpactTargetsParams): Promise<ImpactSelection> {
    const logger = rootLogger.child({ name: "selectImpactTargets", extra: { snapshotId } });
    logger.info("Impact Analysis selection started");

    const agentResult = await runSelection({ snapshotId, codebase, logger });
    const targets = await materializeTargets({ snapshotId, agentResult, logger });
    return { targets, reasoning: agentResult.reasoning };
}

/** The Impact Analysis selection: the tests to investigate + the agent's overall account of why it chose them. */
export interface ImpactSelection {
    targets: AnalysisInvestigationTarget[];
    reasoning: string;
}

interface AgentSelection {
    organizationId: string;
    /** The DiffsAgent's overall summary of what the diff affects and why - the selection reasoning. */
    reasoning: string;
    affectedTests: { slug: string; reasoning: string }[];
    createdTests: { name: string; description: string; plan: string; folderName: string; scenarioId?: string }[];
    flowFolderId(folderName: string): string | undefined;
    /** slug -> testCaseId for the tests assigned to the baseline snapshot (affected tests are among these). */
    testCaseIdBySlug: Map<string, string>;
}

/** Build the DiffsAgent input from the snapshot's own (copied baseline) suite and run the agent. */
async function runSelection({
    snapshotId,
    codebase,
    logger,
}: SelectImpactTargetsParams & { logger: Logger }): Promise<AgentSelection> {
    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { branchId: true, headSha: true, baseSha: true },
    });
    if (snapshot.headSha == null || snapshot.baseSha == null) {
        throw new Error(
            `Snapshot ${snapshotId} is missing SHAs (head: ${snapshot.headSha}, base: ${snapshot.baseSha})`,
        );
    }

    const branchData = await loadBranchData(snapshot.branchId, createGithubApp());
    const suiteInfo = await fetchTestSuiteInfo(db, snapshotId);
    const { metadata } = await loadDiffsContext(
        branchData.applicationId,
        suiteInfo,
        snapshot.headSha,
        snapshot.baseSha,
    );
    const scenarioRecipes = await resolveScenarioRecipesForSnapshot(db, snapshotId, collectScenarioIds(suiteInfo));

    // No merge flow here (that is #1515): empty merges / pre-classified conflicts, so the agent only marks tests
    // it identifies from the diff itself and authors net-new ones.
    const { result } = await runDiffsAgent({
        input: { ...metadata, merges: [], preClassifiedConflicts: [], scenarioRecipes },
        codebase,
    });
    logger.info("DiffsAgent selection complete", {
        extra: { affectedTests: result.affectedTests.length, createdTests: result.createdTests.length },
    });

    return {
        organizationId: branchData.organizationId,
        reasoning: result.reasoning,
        affectedTests: result.affectedTests.map((test) => ({ slug: test.slug, reasoning: test.reasoning })),
        createdTests: result.createdTests.map((test) => ({
            name: test.name,
            description: test.description,
            plan: test.plan,
            folderName: test.folderName,
            scenarioId: test.scenarioId,
        })),
        flowFolderId: (folderName) => metadata.flowIndex.getFlow(folderName)?.id,
        testCaseIdBySlug: new Map(suiteInfo.testCases.map((testCase) => [testCase.slug, testCase.id])),
    };
}

/**
 * Materialize the agent's selection on the job's own detached snapshot via the update actions, then resolve each
 * queued generation to its Investigator target (slug + scenario + reason). Non-web targets are dropped - the
 * Investigator runs web generations only.
 */
async function materializeTargets({
    snapshotId,
    agentResult,
    logger,
}: {
    snapshotId: string;
    agentResult: AgentSelection;
    logger: Logger;
}): Promise<AnalysisInvestigationTarget[]> {
    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId,
        organizationId: agentResult.organizationId,
    });

    const materialized: { generationId: string; reason: string; origin: AnalysisTestOrigin }[] = [];

    // New tests first (AddTest mints test case + plan + assignment + queues a generation). Tagged `proposed` so a
    // later `delete` on an un-establishable one removes the whole (this-run-only) TestCase, not just the assignment.
    for (const test of agentResult.createdTests) {
        const folderId = agentResult.flowFolderId(test.folderName);
        if (folderId == null) throw new Error(`Folder "${test.folderName}" not found for authored test "${test.name}"`);
        const { generationId } = await updater.apply(
            new AddTest({
                name: test.name,
                description: test.description,
                plan: test.plan,
                folderId,
                scenarioId: test.scenarioId,
            }),
        );
        materialized.push({ generationId, reason: NEW_TEST_REASON, origin: "proposed" });
    }

    // Affected tests (RegenerateSteps clears the pinned plan's steps + queues a generation to regenerate them).
    // Tagged `pre_existing` so a later `delete` removes only this run's assignment, never the real suite member.
    for (const affected of agentResult.affectedTests) {
        const testCaseId = agentResult.testCaseIdBySlug.get(affected.slug);
        if (testCaseId == null) {
            logger.warn("Affected test is not in the baseline suite; skipping", { extra: { slug: affected.slug } });
            continue;
        }
        const generationId = await updater.apply(new RegenerateSteps({ testCaseId }));
        materialized.push({ generationId, reason: affected.reasoning, origin: "pre_existing" });
    }

    if (materialized.length === 0) {
        logger.info("Impact Analysis materialized no targets");
        return [];
    }

    const targets = await resolveTargets(materialized, logger);
    logger.info("Impact Analysis materialized targets", {
        extra: { materialized: materialized.length, targets: targets.length },
    });
    return targets;
}

/** Resolve each materialized generation to its slug + scenario + architecture (one read), keeping web targets. */
async function resolveTargets(
    materialized: { generationId: string; reason: string; origin: AnalysisTestOrigin }[],
    logger: Logger,
): Promise<AnalysisInvestigationTarget[]> {
    const rows = await db.testGeneration.findMany({
        where: { id: { in: materialized.map((entry) => entry.generationId) } },
        select: {
            id: true,
            testPlan: {
                select: {
                    scenario: { select: { id: true } },
                    testCase: { select: { slug: true, application: { select: { architecture: true } } } },
                },
            },
        },
    });
    const rowById = new Map(rows.map((row) => [row.id, row]));

    const targets: AnalysisInvestigationTarget[] = [];
    for (const entry of materialized) {
        const row = rowById.get(entry.generationId);
        if (row == null) continue;
        if (row.testPlan.testCase.application.architecture !== "WEB") {
            logger.info("Skipping non-web target - the Investigator runs web generations only", {
                extra: { slug: row.testPlan.testCase.slug },
            });
            continue;
        }
        targets.push({
            slug: row.testPlan.testCase.slug,
            testGenerationId: entry.generationId,
            scenarioId: row.testPlan.scenario?.id,
            reason: entry.reason,
            origin: entry.origin,
        });
    }
    return targets;
}

/** The distinct scenario ids the baseline suite's plans reference (for point-in-time recipe resolution). */
function collectScenarioIds(suiteInfo: Awaited<ReturnType<typeof fetchTestSuiteInfo>>): string[] {
    const ids = new Set<string>();
    for (const testCase of suiteInfo.testCases) {
        const scenarioId = testCase.plan?.scenarioId;
        if (scenarioId != null) ids.add(scenarioId);
    }
    return [...ids];
}
