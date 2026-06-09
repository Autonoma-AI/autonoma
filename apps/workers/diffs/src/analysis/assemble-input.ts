import { db } from "@autonoma/db";
import {
    type AffectedTest,
    type Codebase,
    type DiffsAgentInput,
    resolveScenarioRecipesForSnapshot,
} from "@autonoma/diffs";
import type { GitHubInstallationClient } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import { type TestSuiteInfo, fetchTestSuiteInfo } from "@autonoma/test-updates";
import { createGithubApp } from "../create-services";
import { type BranchData, loadBranchData, loadDiffsContext } from "./load-context";
import { runMergeFlow } from "./merge-flow";

/**
 * Which snapshot's test suite to treat as the analysis baseline.
 *
 * Analysis grades the diff against the suite as it stood *before* this
 * snapshot's pipeline ran. At production analysis time the current snapshot's
 * assignments are still a fresh copy of that baseline, so "current" is correct
 * and cheap. Capture, however, runs after the pipeline has mutated the current
 * snapshot, so it must read the "previous" snapshot to recover the exact same
 * baseline.
 */
export type TestSuiteSource = "current" | "previous";

/** The DiffsAgent input minus the on-disk clone, which the caller owns. */
export type DiffsAgentInputWithoutCodebase = Omit<DiffsAgentInput, "codebase">;

export interface AssembledDiffsAgentInput {
    /** Everything the {@link DiffsAgent} needs except the codebase clone. */
    agentInput: DiffsAgentInputWithoutCodebase;
    /**
     * Affected tests deterministically imported from the merge flow (empty for
     * non-merge runs). The runner combines these with the agent's output before
     * preparing replays; capture ignores them.
     */
    importedAffectedTests: AffectedTest[];
    /** Branch/application/org context, needed downstream for persistence and replay preparation. */
    branchData: BranchData;
}

export interface AssembleDiffsAgentInputParams {
    snapshotId: string;
    /** The on-disk clone (at base + head SHAs). The merge flow operates on this tree. */
    codebase: Codebase;
    /**
     * Which snapshot's suite to use as the analysis baseline. Defaults to
     * "current" (correct + cheap at production analysis time). Capture passes
     * "previous" to recover the baseline after the pipeline has run. See
     * {@link TestSuiteSource}.
     */
    testSuiteSource?: TestSuiteSource;
}

/**
 * Loads and assembles the full {@link DiffsAgentInput} (minus the codebase) for
 * a snapshot: branch data, suite/flow context, and the optional merge flow.
 *
 * This is the shared, DB-backed side-input loader used by both the production
 * analysis runner and the eval-capture utility - capture freezes the assembled
 * input to disk, the runner feeds it straight to the agent. Keeping it in one
 * place guarantees the captured fixture matches what production actually runs.
 *
 * It reads the snapshot directly and never opens a `TestSuiteUpdater`: the
 * updater only loads *pending* snapshots, but capture targets finalized (active)
 * ones, and analysis here only needs to read the snapshot's data, not mutate it.
 */
export async function assembleDiffsAgentInput({
    snapshotId,
    codebase,
    testSuiteSource = "current",
}: AssembleDiffsAgentInputParams): Promise<AssembledDiffsAgentInput> {
    logger.info("Assembling diffs agent input", { extra: { snapshotId, testSuiteSource } });

    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { branchId: true, headSha: true, baseSha: true, prevSnapshotId: true },
    });
    const { branchId, headSha, baseSha, prevSnapshotId } = snapshot;

    if (headSha == null || baseSha == null) {
        throw new Error(
            `Snapshot ${snapshotId} (branch ${branchId}) is missing required SHAs (headSha: ${headSha ?? "null"}, baseSha: ${baseSha ?? "null"})`,
        );
    }

    const githubApp = createGithubApp();

    const branchData = await loadBranchData(branchId, githubApp);
    logger.info("Loaded branch data", { extra: { fullName: branchData.fullName } });

    const githubClient = await githubApp.getInstallationClient(Number(branchData.installationId));

    const suiteInfo = await loadBaselineSuiteInfo(snapshotId, prevSnapshotId, testSuiteSource);
    const { metadata } = await loadDiffsContext(branchData.applicationId, suiteInfo, headSha, baseSha);
    logger.info("Loaded diffs context", { extra: { existingTests: metadata.existingTests.length } });

    const mergeResult = await runOptionalMergeFlow({
        branchData,
        githubClient,
        repoDir: codebase.root,
        baseSha,
        headSha,
        snapshotId,
    });

    const importedSlugs = new Set(mergeResult.importedAffectedTests.map((t) => t.slug));
    const existingTests = metadata.existingTests.filter((t) => !importedSlugs.has(t.slug));

    // Recipe templates for the scenarios the in-scope tests reference, sourced
    // from each scenario's point-in-time recipe version for the *same* snapshot
    // the suite came from. This is template data (what each scenario is designed
    // to seed), not per-run instance data - analysis runs before any replay.
    const baselineSnapshotId = resolveBaselineSnapshotId(snapshotId, prevSnapshotId, testSuiteSource);
    const scenarioRecipes = await resolveScenarioRecipesForSnapshot(
        db,
        baselineSnapshotId,
        collectInScopeScenarioIds(suiteInfo, existingTests),
    );

    const agentInput: DiffsAgentInputWithoutCodebase = {
        ...metadata,
        existingTests,
        merges: mergeResult.merges,
        preClassifiedConflicts: mergeResult.preClassifiedConflicts,
        scenarioRecipes,
    };

    return { agentInput, importedAffectedTests: mergeResult.importedAffectedTests, branchData };
}

/**
 * Resolve the test suite that analysis grades against.
 *
 * For "current" this is the snapshot's own suite (a fresh copy of the baseline
 * at analysis time). For "previous" we read the snapshot's `prevSnapshotId`
 * suite - the unmutated baseline - which is what capture needs since the current
 * snapshot has since been rewritten by the pipeline. Falls back to the current
 * suite when there is no previous snapshot (a genesis snapshot has no baseline
 * to recover).
 */
async function loadBaselineSuiteInfo(
    snapshotId: string,
    prevSnapshotId: string | null,
    source: TestSuiteSource,
): Promise<TestSuiteInfo> {
    if (source === "current") return fetchTestSuiteInfo(db, snapshotId);

    if (prevSnapshotId == null) {
        logger.warn("Snapshot has no previous snapshot; falling back to its own suite as the baseline", {
            extra: { snapshotId },
        });
        return fetchTestSuiteInfo(db, snapshotId);
    }

    logger.info("Using previous snapshot's suite as the analysis baseline", {
        extra: { snapshotId, prevSnapshotId },
    });
    return fetchTestSuiteInfo(db, prevSnapshotId);
}

/**
 * The snapshot whose point-in-time recipe versions analysis should read - the
 * same one its test suite came from. Mirrors {@link loadBaselineSuiteInfo}:
 * "current" reads this snapshot; "previous" reads `prevSnapshotId` (what capture
 * needs), falling back to the current snapshot when there is no previous one.
 */
function resolveBaselineSnapshotId(snapshotId: string, prevSnapshotId: string | null, source: TestSuiteSource): string {
    if (source === "current") return snapshotId;
    return prevSnapshotId ?? snapshotId;
}

/**
 * Distinct scenario ids referenced by the tests actually in the agent's scope.
 * Reads the slug -> scenario mapping off the raw suite (which carries the plan's
 * `scenarioId`, dropped by `mapTestSuiteToContext`), restricted to the in-scope
 * slugs so merge-imported tests don't drag in extra recipes.
 */
function collectInScopeScenarioIds(suiteInfo: TestSuiteInfo, inScopeTests: ReadonlyArray<{ slug: string }>): string[] {
    const inScopeSlugs = new Set(inScopeTests.map((test) => test.slug));
    const scenarioIds = new Set<string>();
    for (const testCase of suiteInfo.testCases) {
        if (!inScopeSlugs.has(testCase.slug)) continue;
        const scenarioId = testCase.plan?.scenarioId;
        if (scenarioId != null) scenarioIds.add(scenarioId);
    }
    return [...scenarioIds];
}

interface OptionalMergeFlowParams {
    branchData: BranchData;
    githubClient: GitHubInstallationClient;
    repoDir: string;
    baseSha: string;
    headSha: string;
    snapshotId: string;
}

async function runOptionalMergeFlow({
    branchData,
    githubClient,
    repoDir,
    baseSha,
    headSha,
    snapshotId,
}: OptionalMergeFlowParams) {
    if (!branchData.isMainBranch) {
        logger.info(
            "Branch is not the application main branch; skipping merge flow (Phase 1 only handles feat/x -> main)",
        );
        return { merges: [], preClassifiedConflicts: [], importedAffectedTests: [] };
    }

    const [owner, repo] = branchData.fullName.split("/");
    if (owner == null || repo == null) {
        logger.warn("Unexpected fullName format; skipping merge flow", { fullName: branchData.fullName });
        return { merges: [], preClassifiedConflicts: [], importedAffectedTests: [] };
    }

    return await runMergeFlow({
        db,
        githubClient,
        owner,
        repo,
        targetBranchRef: branchData.defaultBranch,
        baseSha,
        headSha,
        repoDir,
        targetSnapshotId: snapshotId,
        applicationId: branchData.applicationId,
    });
}
