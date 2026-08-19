import { db } from "@autonoma/db";
import { type Codebase, resolveScenarioRecipesForSnapshot } from "@autonoma/diffs";
import type { GitHubApp } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";
import { type OpenSnapshot, type Suite, TestSuiteStore } from "@autonoma/test-suite";
import type { AnalysisInvestigationTarget } from "@autonoma/workflow/activities";
import { createGithubApp } from "../create-services";
import { type BranchData, loadBranchData, loadDiffsContext } from "./load-context";
import { type AgentSelection, materializeSelection } from "./materialize-selection";
import { EMPTY_MERGE_FLOW_RESULT, type MergeFlowResult, runMergeFlow } from "./merge-flow";
import { reverifyOpenIssues } from "./reverify-issues";
import { runDiffsAgent } from "./run-diffs-agent";

const logger = rootLogger.child({ name: "selectImpactTargets" });

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
 * history, no carry-forward) to mark affected tests and author brand-new ones. A brand-new test is authored onto the
 * run's OWN snapshot via `addTest`; an affected test needs no suite write at all. Finally it adds the covering tests
 * of the branch's open bug-kind issues (see {@link reverifyOpenIssues}), which is what lets a fixed bug resolve
 * rather than sit open forever.
 *
 * The result is a target list of `(test, reason, origin)` - merge-imported, new, affected and re-verified tests
 * enter the Investigator fan-out identically, deduplicated by test, and each Investigator starts its own runs.
 */
export async function selectImpactTargets({
    snapshotId,
    codebase,
}: SelectImpactTargetsParams): Promise<ImpactSelection> {
    logger.info("Impact Analysis selection started");

    const githubApp = createGithubApp();
    const store = new TestSuiteStore(db);
    const snapshot = await store.reopen(snapshotId);
    const coordinates = requireCoordinates(snapshot);
    const branchData = await loadBranchData(snapshot.branchId, githubApp);

    const merge = await absorbMergedBranchWork({
        store,
        snapshot,
        branchData,
        githubApp,
        coordinates,
        codebase,
    });

    const agentResult = await runSelection({ snapshot, branchData, coordinates, codebase, merge });

    const selected = await materializeSelection({ snapshot, agentResult });
    const reverified = await reverifyOpenIssues({ db, snapshot });

    // One target per test, wherever the sources overlap (a re-verified test the diff also affected, a merge import
    // the conflict pass also named). First wins: the more specific provenance comes earlier in the list.
    const targets = dedupeTargets([
        // The TestCase is a real suite member, authored and already run on the branch that merged it.
        ...merge.imports.map((imported) => ({
            slug: imported.slug,
            testCaseId: imported.testCaseId,
            reason: imported.reason,
            origin: "pre_existing" as const,
        })),
        ...selected,
        // A re-verified test is a real suite member too - it is only in the run set because it once exposed the bug.
        ...reverified.map((test) => ({
            slug: test.slug,
            testCaseId: test.testCaseId,
            reason: test.reason,
            origin: "pre_existing" as const,
        })),
    ]);

    logger.info("Impact Analysis selection complete", { extra: { targets: targets.length } });
    return { targets, reasoning: agentResult.reasoning };
}

/** The Impact Analysis selection: the tests to investigate + the agent's overall account of why it chose them. */
export interface ImpactSelection {
    targets: AnalysisInvestigationTarget[];
    reasoning: string;
}

/** The run's git coordinates: what the diff is taken between. */
interface SnapshotCoordinates {
    headSha: string;
    baseSha: string;
}

/**
 * Two Investigators on one test would race for its single `(snapshot, testCase)` finding row, so the target list
 * holds one entry per test. First entry wins; a duplicate is logged and skipped.
 */
function dedupeTargets(targets: AnalysisInvestigationTarget[]): AnalysisInvestigationTarget[] {
    const deduped: AnalysisInvestigationTarget[] = [];
    const claimedTestCaseIds = new Set<string>();
    for (const target of targets) {
        if (claimedTestCaseIds.has(target.testCaseId)) {
            logger.info("Test was already targeted this run; ignoring the duplicate", {
                extra: { slug: target.slug },
            });
            continue;
        }
        claimedTestCaseIds.add(target.testCaseId);
        deduped.push(target);
    }
    return deduped;
}

function requireCoordinates(snapshot: OpenSnapshot): SnapshotCoordinates {
    if (snapshot.headSha == null || snapshot.baseSha == null) {
        throw new Error(
            `Snapshot ${snapshot.snapshotId} is missing SHAs (head: ${snapshot.headSha}, base: ${snapshot.baseSha})`,
        );
    }
    return { headSha: snapshot.headSha, baseSha: snapshot.baseSha };
}

/**
 * Run the merge flow when this run is the application's main branch, where merges land. Phase 1 only handles the
 * `feat/x -> main` direction, so a PR-branch run has no merged work to absorb.
 */
async function absorbMergedBranchWork({
    store,
    snapshot,
    branchData,
    githubApp,
    coordinates,
    codebase,
}: {
    store: TestSuiteStore;
    snapshot: OpenSnapshot;
    branchData: BranchData;
    githubApp: GitHubApp;
    coordinates: SnapshotCoordinates;
    codebase: Codebase;
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
        store,
        snapshot,
        githubClient,
        owner,
        repo,
        targetBranchRef: branchData.defaultBranch,
        baseSha: coordinates.baseSha,
        headSha: coordinates.headSha,
        // primaryDir, not root: in a multi-repo workspace `root` is the parent that holds the repos, not a repo -
        // the merge flow runs git against the primary repo's own clone.
        repoDir: codebase.primaryDir,
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
    snapshot,
    branchData,
    coordinates,
    codebase,
    merge,
}: {
    snapshot: OpenSnapshot;
    branchData: BranchData;
    coordinates: SnapshotCoordinates;
    codebase: Codebase;
    merge: MergeFlowResult;
}): Promise<AgentSelection> {
    const suite = await snapshot.read();
    const { metadata } = await loadDiffsContext({
        applicationId: branchData.applicationId,
        suiteInfo: suite,
        headSha: coordinates.headSha,
        baseSha: coordinates.baseSha,
        branchId: snapshot.branchId,
        snapshotId: snapshot.snapshotId,
    });
    const scenarioRecipes = await resolveScenarioRecipesForSnapshot(db, snapshot.snapshotId, collectScenarioIds(suite));

    // An imported test is already in the run set with its plan settled, so it is withheld from the agent's list -
    // marking it affected would only target the same test twice. Conflicts stay listed: the agent reads their
    // current plans to explain how the legs diverge.
    const importedSlugs = new Set(merge.imports.map((imported) => imported.slug));
    const existingTests = metadata.existingTests.filter((test) => !importedSlugs.has(test.slug));

    const { result } = await runDiffsAgent({
        snapshotId: snapshot.snapshotId,
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
        testCaseIdBySlug: new Map(suite.testCases.map((testCase) => [testCase.slug, testCase.id])),
    };
}

/** The distinct scenario ids the suite's plans reference (for point-in-time recipe resolution). */
function collectScenarioIds(suite: Suite): string[] {
    const ids = new Set<string>();
    for (const testCase of suite.testCases) {
        const scenarioId = testCase.plan?.scenarioId;
        if (scenarioId != null) ids.add(scenarioId);
    }
    return [...ids];
}
