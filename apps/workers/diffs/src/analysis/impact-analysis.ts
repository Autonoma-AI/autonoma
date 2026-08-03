import { db } from "@autonoma/db";
import { type Codebase, resolveScenarioRecipesForSnapshot } from "@autonoma/diffs";
import type { GitHubApp } from "@autonoma/github";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    AddTest,
    RegenerateSteps,
    type TestSuiteInfo,
    TestSuiteUpdater,
    fetchTestSuiteInfo,
} from "@autonoma/test-updates";
import type { AnalysisTestOrigin } from "@autonoma/types";
import type { AnalysisInvestigationTarget } from "@autonoma/workflow/activities";
import { createGithubApp } from "../create-services";
import { type BranchData, loadBranchData, loadDiffsContext } from "./load-context";
import { EMPTY_MERGE_FLOW_RESULT, type MergeFlowResult, runMergeFlow } from "./merge-flow";
import { runDiffsAgent } from "./run-diffs-agent";

/**
 * Why a newly-authored test is in the run set - passed to the classifier as context. The DiffsAgent authors it
 * as a COMPLETE plan for functionality this PR adds, so the run confirms the app supports the scenario it covers.
 */
const NEW_TEST_REASON =
    "New test authored by Impact Analysis for functionality this PR adds - run it to confirm the app supports the scenario it covers.";

export interface SelectImpactTargetsParams {
    /** The run's own snapshot the pipeline operates on. */
    snapshotId: string;
    /** The on-disk clone at base + head SHAs, owned by the activity. */
    codebase: Codebase;
}

/**
 * The Impact Analysis stage of the merged pipeline.
 *
 * On a main-branch run it first absorbs the merge flow (see {@link runMergeFlow}): the plan edits of the PRs that
 * merged in since the last main run are imported and their deletions propagated, so main grades the diff against
 * the suite those PRs actually left behind rather than re-deriving a pre-fix plan and failing it.
 *
 * Then it reuses the DiffsAgent (the same stateless selection the diffs job ran - diff + current suite, no prior-run
 * history, no carry-forward) to mark affected tests and author brand-new ones, materializing every target through
 * the canonical update actions on the run's OWN snapshot - `AddTest` for a new test (test case + plan + assignment),
 * `RegenerateSteps` for an affected test. Each action queues one pending generation; merge-imported, new and
 * affected tests then enter the Investigator fan-out identically (all three are assignments the Investigator cannot
 * tell apart). The generations are NOT batch-fired - each Investigator fires its own by id (epic invariant 2).
 */
export async function selectImpactTargets({
    snapshotId,
    codebase,
}: SelectImpactTargetsParams): Promise<ImpactSelection> {
    const logger = rootLogger.child({ name: "selectImpactTargets", extra: { snapshotId } });
    logger.info("Impact Analysis selection started");

    const githubApp = createGithubApp();
    const snapshot = await loadSnapshotCoordinates(snapshotId);
    const branchData = await loadBranchData(snapshot.branchId, githubApp);

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId,
        organizationId: branchData.organizationId,
    });

    const merge = await absorbMergedBranchWork({ updater, branchData, githubApp, snapshot, codebase, logger });

    const agentResult = await runSelection({ updater, branchData, snapshot, codebase, merge, logger });

    const materialized = [
        ...merge.imports.map((imported) => ({
            generationId: imported.generationId,
            reason: imported.reason,
            // The TestCase is a real suite member, authored and already run on the branch that merged it.
            origin: "pre_existing" as const,
        })),
        ...(await materializeSelection({ updater, agentResult, logger })),
    ];

    const targets = await resolveTargets(materialized, logger);
    logger.info("Impact Analysis selection complete", {
        extra: { materialized: materialized.length, targets: targets.length },
    });
    return { targets, reasoning: agentResult.reasoning };
}

/** The Impact Analysis selection: the tests to investigate + the agent's overall account of why it chose them. */
export interface ImpactSelection {
    targets: AnalysisInvestigationTarget[];
    reasoning: string;
}

/** The run's git coordinates: what the diff is taken between, and whose branch it belongs to. */
interface SnapshotCoordinates {
    branchId: string;
    headSha: string;
    baseSha: string;
}

async function loadSnapshotCoordinates(snapshotId: string): Promise<SnapshotCoordinates> {
    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { branchId: true, headSha: true, baseSha: true },
    });
    if (snapshot.headSha == null || snapshot.baseSha == null) {
        throw new Error(
            `Snapshot ${snapshotId} is missing SHAs (head: ${snapshot.headSha}, base: ${snapshot.baseSha})`,
        );
    }
    return { branchId: snapshot.branchId, headSha: snapshot.headSha, baseSha: snapshot.baseSha };
}

/**
 * Run the merge flow when this run is the application's main branch, where merges land. Phase 1 only handles the
 * `feat/x -> main` direction, so a PR-branch run has no merged work to absorb.
 */
async function absorbMergedBranchWork({
    updater,
    branchData,
    githubApp,
    snapshot,
    codebase,
    logger,
}: {
    updater: TestSuiteUpdater;
    branchData: BranchData;
    githubApp: GitHubApp;
    snapshot: SnapshotCoordinates;
    codebase: Codebase;
    logger: Logger;
}): Promise<MergeFlowResult> {
    if (!branchData.isMainBranch) {
        logger.info("Not a main-branch run; skipping the merge flow");
        return EMPTY_MERGE_FLOW_RESULT;
    }

    const [owner, repo] = branchData.fullName.split("/");
    if (owner == null || repo == null) {
        logger.warn("Unexpected repository fullName; skipping the merge flow", {
            extra: { fullName: branchData.fullName },
        });
        return EMPTY_MERGE_FLOW_RESULT;
    }

    const githubClient = await githubApp.getInstallationClient(Number(branchData.installationId));
    const result = await runMergeFlow({
        db,
        updater,
        githubClient,
        owner,
        repo,
        targetBranchRef: branchData.defaultBranch,
        baseSha: snapshot.baseSha,
        headSha: snapshot.headSha,
        repoDir: codebase.root,
    });

    logger.info("Merge flow absorbed", {
        extra: {
            merges: result.merges.length,
            imports: result.imports.length,
            removed: result.removedSlugs.length,
            conflicts: result.preClassifiedConflicts.length,
        },
    });
    return result;
}

interface AgentSelection {
    /** The DiffsAgent's overall summary of what the diff affects and why - the selection reasoning. */
    reasoning: string;
    affectedTests: { slug: string; reasoning: string }[];
    createdTests: { name: string; description: string; plan: string; folderName: string; scenarioId?: string }[];
    flowFolderId(folderName: string): string | undefined;
    /** slug -> testCaseId for the tests this snapshot assigns (affected tests are among these). */
    testCaseIdBySlug: Map<string, string>;
}

/**
 * Build the DiffsAgent input from the snapshot's suite - read AFTER the merge flow applied, so it already carries
 * the imported plans and no longer carries the propagated deletions - and run the agent.
 */
async function runSelection({
    updater,
    branchData,
    snapshot,
    codebase,
    merge,
    logger,
}: {
    updater: TestSuiteUpdater;
    branchData: BranchData;
    snapshot: SnapshotCoordinates;
    codebase: Codebase;
    merge: MergeFlowResult;
    logger: Logger;
}): Promise<AgentSelection> {
    const suiteInfo = await fetchTestSuiteInfo(db, updater.snapshotId);
    const { metadata } = await loadDiffsContext(
        branchData.applicationId,
        suiteInfo,
        snapshot.headSha,
        snapshot.baseSha,
    );
    const scenarioRecipes = await resolveScenarioRecipesForSnapshot(
        db,
        updater.snapshotId,
        collectScenarioIds(suiteInfo),
    );

    // An imported test is already in the run set with its plan settled, so it is withheld from the agent's list -
    // marking it affected would only queue a second generation for the same test. Conflicts stay listed: the agent
    // reads their current plans to explain how the legs diverge.
    const importedSlugs = new Set(merge.imports.map((imported) => imported.slug));
    const existingTests = metadata.existingTests.filter((test) => !importedSlugs.has(test.slug));

    const { result } = await runDiffsAgent({
        snapshotId: updater.snapshotId,
        input: {
            ...metadata,
            existingTests,
            merges: merge.merges,
            preClassifiedConflicts: merge.preClassifiedConflicts,
            scenarioRecipes,
        },
        codebase,
    });
    logger.info("DiffsAgent selection complete", {
        extra: { affectedTests: result.affectedTests.length, createdTests: result.createdTests.length },
    });

    return {
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

/** One queued generation the stage is responsible for, before it is resolved to an Investigator target. */
interface MaterializedTarget {
    generationId: string;
    reason: string;
    origin: AnalysisTestOrigin;
}

/** Materialize the agent's selection on the run's own snapshot via the update actions. */
async function materializeSelection({
    updater,
    agentResult,
    logger,
}: {
    updater: TestSuiteUpdater;
    agentResult: AgentSelection;
    logger: Logger;
}): Promise<MaterializedTarget[]> {
    const materialized: MaterializedTarget[] = [];

    // New tests first (AddTest mints test case + plan + assignment + queues a generation). Tagged `proposed` because
    // the TestCase exists only for this run, which is what makes its finding read as an added test.
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
    // Tagged `pre_existing` because the TestCase is a real suite member this PR's diff affected.
    for (const affected of agentResult.affectedTests) {
        const testCaseId = agentResult.testCaseIdBySlug.get(affected.slug);
        if (testCaseId == null) {
            logger.warn("Affected test is not in the snapshot's suite; skipping", { extra: { slug: affected.slug } });
            continue;
        }
        const generationId = await updater.apply(new RegenerateSteps({ testCaseId }));
        materialized.push({ generationId, reason: affected.reasoning, origin: "pre_existing" });
    }

    return materialized;
}

/** Resolve each materialized generation to its test + scenario + architecture (one read), keeping web targets. */
async function resolveTargets(
    materialized: MaterializedTarget[],
    logger: Logger,
): Promise<AnalysisInvestigationTarget[]> {
    if (materialized.length === 0) {
        logger.info("Impact Analysis materialized no targets");
        return [];
    }

    const rows = await db.testGeneration.findMany({
        where: { id: { in: materialized.map((entry) => entry.generationId) } },
        select: {
            id: true,
            testPlan: {
                select: {
                    scenario: { select: { id: true } },
                    testCase: { select: { id: true, slug: true, application: { select: { architecture: true } } } },
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
            testCaseId: row.testPlan.testCase.id,
            testGenerationId: entry.generationId,
            scenarioId: row.testPlan.scenario?.id,
            reason: entry.reason,
            origin: entry.origin,
        });
    }
    return targets;
}

/** The distinct scenario ids the suite's plans reference (for point-in-time recipe resolution). */
function collectScenarioIds(suiteInfo: TestSuiteInfo): string[] {
    const ids = new Set<string>();
    for (const testCase of suiteInfo.testCases) {
        const scenarioId = testCase.plan?.scenarioId;
        if (scenarioId != null) ids.add(scenarioId);
    }
    return [...ids];
}
