import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@autonoma/db";
import { FlowIndex, bucketPlanOutcomes, loadFlows, mapTestSuiteToContext } from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { fetchTestSuiteInfo } from "@autonoma/test-updates";
import { createGithubApp } from "../../src/create-services";
import {
    type HealingInputWithoutCodebase,
    collectFailureRecords,
    loadFirstTurnCandidates,
    loadPlanAuthoringInput,
    mergeDiffJobContext,
    toHealingSubject,
} from "../../src/refinement/assemble-healing-input";
import { DiffJobContextLoader } from "../../src/review/diff-job-context-loader";
import { requireCasesDir } from "../framework/cases-dir";
import { ensureCachedCheckout } from "../framework/codebase-cache";
import { serializeHealingInput } from "../healing/healing-input";
import { buildHealingExpected } from "./healing-expected-scaffold";
import { resolveSnapshotCoords } from "./snapshot-coords";

export interface CaptureHealingFromSnapshotParams {
    snapshotId: string;
    /** Case folder name (defaults to the snapshot id). */
    name?: string;
    /** Overwrite an existing case folder. */
    force?: boolean;
}

/**
 * Capture a Healing eval case for the folded-resolution **first turn** directly
 * from a snapshot, with no `RefinementIteration` row to start from.
 *
 * This is the path for **pre-#986** (and any loop-less) diffs snapshots, where
 * "resolution" ran outside the refinement loop so no iteration exists for
 * {@link captureHealing} to bucket. Everything the first turn saw is still in the
 * DB, just keyed by snapshot: the failures come from the affected-test replays
 * (the same plans `seedDiffsReplayPlanIds` seeds iteration 1 from), the
 * candidates from the snapshot's Step 1 proposals, and the change / analysis
 * reasoning / per-failure lineage from the shared {@link DiffJobContextLoader}.
 * The result is the same frozen `HealingInput` the iteration-based capture
 * produces, so it replays through the merged Healing agent identically.
 *
 * The suite (`existingTests` + flows) is read from the **previous** snapshot:
 * pre-#986 resolution mutated this snapshot's own assignments (modify/remove),
 * so the previous snapshot holds the unmutated baseline the first turn saw -
 * mirroring what the old `capture:resolution` did.
 */
export async function captureHealingFromSnapshot(params: CaptureHealingFromSnapshotParams): Promise<string> {
    const logger = rootLogger.child({ name: "captureHealingFromSnapshot" });
    const { snapshotId } = params;
    const name = params.name ?? snapshotId;
    const caseDir = path.join(requireCasesDir("healing"), name);

    logger.info("Capturing first-turn healing case from snapshot", { extra: { snapshotId, name, caseDir } });

    if (existsSync(caseDir) && params.force !== true) {
        throw new Error(`Case folder already exists: ${caseDir} (pass --force to overwrite)`);
    }

    const githubApp = createGithubApp();
    const coords = await resolveSnapshotCoords(snapshotId, githubApp);

    // Validate SHA-fetchability (throws UnfetchableShaError on a dead SHA, so we
    // never write an unrunnable case) and give downstream loaders a working tree.
    await ensureCachedCheckout(coords, { githubApp });

    const agentInput = await assembleFirstTurnInput(snapshotId, logger);

    const noWork = agentInput.failures.length === 0 && agentInput.candidates.length === 0;
    if (noWork) {
        throw new Error(
            `Snapshot ${snapshotId} has no failed affected-test replays and no candidates - nothing to capture. ` +
                "Is this a diffs snapshot whose analysis step ran (the folded-resolution first turn)?",
        );
    }

    const frozenInput = serializeHealingInput(coords, agentInput, agentInput.planAuthoring.scenarios.toArray());

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "input.json"), `${JSON.stringify(frozenInput, null, 2)}\n`, "utf-8");
    await writeFile(
        path.join(caseDir, "expected.md"),
        buildHealingExpected(`snapshot ${snapshotId}`, frozenInput.failures, frozenInput.candidates),
        "utf-8",
    );

    logger.info("Captured first-turn healing case", {
        extra: {
            caseDir,
            failures: frozenInput.failures.length,
            candidates: frozenInput.candidates.length,
            scenarios: frozenInput.planAuthoring.scenarios.length,
            flows: frozenInput.planAuthoring.flows.length,
        },
    });

    return caseDir;
}

/**
 * Reconstruct the first turn's {@link HealingInputWithoutCodebase} from a
 * snapshot, reusing the same shared loaders {@link assembleHealingInput} does.
 * The only first-turn specifics: `iteration` is 1, `priorActions` is empty (no
 * earlier loop turns), and the suite is read from the previous snapshot's
 * baseline.
 */
async function assembleFirstTurnInput(snapshotId: string, logger: Logger): Promise<HealingInputWithoutCodebase> {
    const planIds = await seedReplayPlanIds(snapshotId);
    const baselineSnapshotId = await resolveSuiteBaselineSnapshotId(snapshotId, logger);

    const buckets = await bucketPlanOutcomes(db, snapshotId, planIds, logger);
    const baseFailures = collectFailureRecords(buckets.failuresAtGeneration, buckets.failuresAtReplay);

    const [diffJobContext, candidates, suiteInfo] = await Promise.all([
        new DiffJobContextLoader(db).loadHealingContext({
            snapshotId,
            subjects: baseFailures.map(toHealingSubject),
        }),
        // Iteration 1 is the folded-resolution first turn - the only turn that carries candidates.
        loadFirstTurnCandidates(1, snapshotId),
        fetchTestSuiteInfo(db, baselineSnapshotId),
    ]);

    const { applicationId, organizationId } = diffJobContext;
    const { existingTests } = mapTestSuiteToContext(suiteInfo);

    const [planAuthoring, flows] = await Promise.all([
        loadPlanAuthoringInput({ db, applicationId, snapshotId: baselineSnapshotId }),
        loadFlows(db, applicationId, suiteInfo),
    ]);

    const failures = mergeDiffJobContext(baseFailures, diffJobContext.subjects);

    return {
        iteration: 1,
        priorActions: [],
        failures,
        candidates,
        flowIndex: new FlowIndex(flows),
        existingTests,
        planAuthoring,
        snapshotId,
        applicationId,
        organizationId,
        change: diffJobContext.change,
        analysisReasoning: diffJobContext.analysisReasoning,
    };
}

/**
 * The first turn's seed plan ids: the affected tests' committed plans, taken
 * from the replays the diffs analysis step ran. Mirrors `seedDiffsReplayPlanIds`
 * in `apps/workers/general/.../refinement/loop-lifecycle.ts` - keep the two in
 * sync. Only affected tests with a plan-linked run contribute (one without a run
 * has neither a generation nor a run and would trip the bucketer's invariant).
 */
async function seedReplayPlanIds(snapshotId: string): Promise<string[]> {
    const affected = await db.affectedTest.findMany({
        where: { snapshotId, runId: { not: null } },
        select: { run: { select: { planId: true } } },
    });

    return [...new Set(affected.map((a) => a.run?.planId).filter((id): id is string => id != null))];
}

/**
 * Resolve which snapshot to read the suite baseline from. Pre-#986 resolution
 * mutated this snapshot's own assignments, so the previous snapshot holds the
 * unmutated suite the first turn saw. Falls back to the snapshot itself when
 * there is no previous one (a genesis snapshot has no baseline to recover).
 */
async function resolveSuiteBaselineSnapshotId(snapshotId: string, logger: Logger): Promise<string> {
    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { prevSnapshotId: true },
    });

    if (snapshot.prevSnapshotId == null) {
        logger.warn("Snapshot has no previous snapshot; reading the suite from the snapshot itself", {
            extra: { snapshotId },
        });
        return snapshotId;
    }

    return snapshot.prevSnapshotId;
}
