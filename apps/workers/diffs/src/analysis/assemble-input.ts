import { db } from "@autonoma/db";
import { type DiffsAgentInput, resolveScenarioRecipesForSnapshot } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";
import { type TestSuiteInfo, fetchTestSuiteInfo } from "@autonoma/test-updates";
import { createGithubApp } from "../create-services";
import { type BranchData, loadBranchData, loadDiffsContext } from "./load-context";

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
    /** Branch/application/org context, needed downstream for persistence and replay preparation. */
    branchData: BranchData;
}

export interface AssembleDiffsAgentInputParams {
    snapshotId: string;
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
 * a snapshot: branch data plus suite/flow context.
 *
 * This is the DB-backed side-input loader behind the retired diffs analysis
 * runner and the eval-capture utility - capture freezes the assembled input to
 * disk, the runner feeds it straight to the agent.
 *
 * It reads the snapshot directly and never opens a `TestSuiteUpdater`: the
 * updater only loads *pending* snapshots, but capture targets finalized (active)
 * ones, and analysis here only needs to read the snapshot's data, not mutate it.
 * The merge flow is therefore not run here - it writes to the suite, and its home
 * is the Impact Analysis stage (`selectImpactTargets`).
 */
export async function assembleDiffsAgentInput({
    snapshotId,
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

    const branchData = await loadBranchData(branchId, createGithubApp());
    logger.info("Loaded branch data", { extra: { fullName: branchData.fullName } });

    const suiteInfo = await loadBaselineSuiteInfo(snapshotId, prevSnapshotId, testSuiteSource);
    const { metadata } = await loadDiffsContext(branchData.applicationId, suiteInfo, headSha, baseSha);
    logger.info("Loaded diffs context", { extra: { existingTests: metadata.existingTests.length } });

    // Recipe templates for the scenarios the in-scope tests reference, sourced
    // from each scenario's point-in-time recipe version for the *same* snapshot
    // the suite came from. This is template data (what each scenario is designed
    // to seed), not per-run instance data - analysis runs before any replay.
    const baselineSnapshotId = resolveBaselineSnapshotId(snapshotId, prevSnapshotId, testSuiteSource);
    const scenarioRecipes = await resolveScenarioRecipesForSnapshot(
        db,
        baselineSnapshotId,
        collectInScopeScenarioIds(suiteInfo, metadata.existingTests),
    );

    const agentInput: DiffsAgentInputWithoutCodebase = { ...metadata, scenarioRecipes };

    return { agentInput, branchData };
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
 * slugs.
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
