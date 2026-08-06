import { db } from "@autonoma/db";
import { type Codebase, resolveScenarioRecipesForSnapshot } from "@autonoma/diffs";
import type { GitHubApp } from "@autonoma/github";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type TestSuiteInfo, TestSuiteUpdater, fetchTestSuiteInfo } from "@autonoma/test-updates";
import type { AnalysisInvestigationTarget } from "@autonoma/workflow/activities";
import { createGithubApp } from "../create-services";
import { type BranchData, loadBranchData, loadDiffsContext } from "./load-context";
import { type AgentSelection, materializeSelection } from "./materialize-selection";
import { EMPTY_MERGE_FLOW_RESULT, type MergeFlowResult, runMergeFlow } from "./merge-flow";
import { resolveTargets } from "./resolve-targets";
import { reverifyOpenIssues } from "./reverify-issues";
import { runDiffsAgent } from "./run-diffs-agent";

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
 * `RegenerateSteps` for an affected test. Finally it adds the covering tests of the branch's open bug-kind issues
 * (see {@link reverifyOpenIssues}), which is what lets a fixed bug resolve rather than sit open forever.
 *
 * Each action queues one pending generation; merge-imported, new, affected and re-verified tests then enter the
 * Investigator fan-out identically (all four are assignments the Investigator cannot tell apart). The generations are
 * NOT batch-fired - each Investigator fires its own by id.
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

    // Strictly after the diff selection: re-verification reads the snapshot's pending generations to know which tests
    // the run already covers, and skips them - a second generation for one test deletes the first.
    const selected = await materializeSelection({ updater, agentResult, logger });
    const reverified = await reverifyOpenIssues({ db, updater, logger });

    const materialized = [
        ...merge.imports.map((imported) => ({
            generationId: imported.generationId,
            reason: imported.reason,
            // The TestCase is a real suite member, authored and already run on the branch that merged it.
            origin: "pre_existing" as const,
        })),
        ...selected,
        // A re-verified test is a real suite member too - it is only in the run set because it once exposed the bug.
        ...reverified.map((test) => ({
            generationId: test.generationId,
            reason: test.reason,
            origin: "pre_existing" as const,
        })),
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
        affectedTests: result.affectedTests.map((test) => ({
            slug: test.slug,
            reasoning: test.reasoning,
            affectedReason: test.affectedReason,
        })),
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

/** The distinct scenario ids the suite's plans reference (for point-in-time recipe resolution). */
function collectScenarioIds(suiteInfo: TestSuiteInfo): string[] {
    const ids = new Set<string>();
    for (const testCase of suiteInfo.testCases) {
        const scenarioId = testCase.plan?.scenarioId;
        if (scenarioId != null) ids.add(scenarioId);
    }
    return [...ids];
}
