import { logger as rootLogger } from "@autonoma/logger";
import type { AnalysisActivities } from "@autonoma/workflow/activities";
import { heartbeat } from "@temporalio/activity";

// Opening the run is the one analysis step with nothing long-running to do, so it skips the heartbeat wrapper.
export { openAnalysisRun } from "./analysis/open-analysis-run";

import { deleteAnalysisTest as deleteAnalysisTestImpl } from "./analysis/delete-test";
import { openAnalysisRun } from "./analysis/open-analysis-run";
import { openMergeGate as openMergeGateImpl } from "./analysis/open-merge-gate";
import { persistAnalysisClassification as persistAnalysisClassificationImpl } from "./analysis/persist-classification";
import { revertSelfHealPlan as revertSelfHealPlanImpl } from "./analysis/revert-self-heal-plan";
import { runImpactAnalysis as runImpactAnalysisImpl } from "./analysis/run-impact-analysis";
import { runReporter as runReporterImpl } from "./analysis/run-reporter";
import { selfHealAnalysisTest as selfHealAnalysisTestImpl } from "./analysis/self-heal-test";
import { settleAnalysisRun as settleAnalysisRunImpl } from "./analysis/settle-analysis-run";
import { startInvestigationRun as startInvestigationRunImpl } from "./analysis/start-investigation-run";
import { classifyInvestigationRun as classifyImpl } from "./classify-run";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Wrap a long-running analysis-pipeline activity so it heartbeats every 30s while it works. The impact-analysis
 * selector clone + LLM call and the classify reasoning loop run for MINUTES inside a single async call and
 * cannot heartbeat internally - so without this, Temporal's heartbeatTimeout (2m on these activities) kills any
 * run longer than two minutes. `heartbeat()` throws outside an activity context (e.g. an eval/test runner), so
 * we stop the timer on the first such failure - a no-op everywhere else.
 */
function withHeartbeat<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
        const timer = setInterval(() => {
            try {
                heartbeat();
            } catch (error) {
                clearInterval(timer);
                rootLogger.debug("Not in a Temporal activity context; skipping heartbeats", { err: error });
            }
        }, HEARTBEAT_INTERVAL_MS);
        try {
            return await fn(...args);
        } finally {
            clearInterval(timer);
        }
    };
}

// --- Merged analysis pipeline. runImpactAnalysis clones the repo + runs the DiffsAgent selector, classify runs
// the reasoning loop, and the Reporter clones the repo + runs an agent loop - all take MINUTES, so all MUST
// heartbeat; finalize (verdict derivation + promotion plumbing) is fast but heartbeats for consistency.
export const openMergeGate = withHeartbeat(openMergeGateImpl);
export const runImpactAnalysis = withHeartbeat(runImpactAnalysisImpl);
export const runReporter = withHeartbeat(runReporterImpl);
export const settleAnalysisRun = withHeartbeat(settleAnalysisRunImpl);
export const classifyInvestigationRun = withHeartbeat(classifyImpl);
// The Investigator's own writes: the run it starts per iteration (startInvestigationRun), its row-local self-heal
// plan rewrite (revisePlan), the revert of that rewrite when a `plan_mismatch` is kept (restorePlan, no re-run),
// the removal of an irreparable test on `invalid_test` (dropTest), and the append with which it files each
// iteration's classification. All fast, but heartbeat for consistency with the other analysis activities.
export const startInvestigationRun = withHeartbeat(startInvestigationRunImpl);
export const selfHealAnalysisTest = withHeartbeat(selfHealAnalysisTestImpl);
export const revertSelfHealPlan = withHeartbeat(revertSelfHealPlanImpl);
export const deleteAnalysisTest = withHeartbeat(deleteAnalysisTestImpl);
export const persistAnalysisClassification = withHeartbeat(persistAnalysisClassificationImpl);

// Compile-time check: this worker implements the whole DIFFS-queue contract - the run's stages, the per-test
// classify, and the Investigator's row-local writes.
({
    openAnalysisRun,
    openMergeGate,
    runImpactAnalysis,
    startInvestigationRun,
    classifyInvestigationRun,
    selfHealAnalysisTest,
    revertSelfHealPlan,
    deleteAnalysisTest,
    persistAnalysisClassification,
    runReporter,
    settleAnalysisRun,
}) satisfies AnalysisActivities;
