import { logger as rootLogger } from "@autonoma/logger";
import type {
    AnalysisActivities,
    DiffsActivities,
    InvestigationActivities,
    InvestigatorActivities,
} from "@autonoma/workflow/activities";
import { heartbeat } from "@temporalio/activity";

export { analyzeDiffs } from "./analyze-diffs";
export { markDiffsGenerating } from "./mark-diffs-generating";
export { finalizeDiffs } from "./finalize-diffs";
export { reviewGeneration } from "./review/generation";
export { runHealingAgentForRefinement } from "./refinement/run-healing-agent";

import { deleteAnalysisTest as deleteAnalysisTestImpl } from "./analysis/delete-test";
import { finalizeAnalysis as finalizeAnalysisImpl } from "./analysis/finalize-analysis";
import { reconcileAnalysis as reconcileAnalysisImpl } from "./analysis/reconcile-analysis";
import { runImpactAnalysis as runImpactAnalysisImpl } from "./analysis/run-impact-analysis";
import { selfHealAnalysisTest as selfHealAnalysisTestImpl } from "./analysis/self-heal-test";
import { analyzeDiffs } from "./analyze-diffs";
import { classifyInvestigationRun as classifyImpl } from "./classify-run";
import { finalizeDiffs } from "./finalize-diffs";
import { markDiffsGenerating } from "./mark-diffs-generating";
import { runHealingAgentForRefinement } from "./refinement/run-healing-agent";
import { reviewGeneration } from "./review/generation";

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

// --- Merged analysis pipeline (shadow), re-homed from the investigation worker. runImpactAnalysis clones the
// repo + runs the DiffsAgent selector, and classify runs the reasoning loop - both take MINUTES, so both MUST
// heartbeat; reconcile (comparison lookup + shadow-store write) and finalize (plumbing) are fast but heartbeat
// for consistency.
export const runImpactAnalysis = withHeartbeat(runImpactAnalysisImpl);
export const reconcileAnalysis = withHeartbeat(reconcileAnalysisImpl);
export const finalizeAnalysis = withHeartbeat(finalizeAnalysisImpl);
export const classifyInvestigationRun = withHeartbeat(classifyImpl);
// The Investigator's own row-local writes on the detached snapshot: a self-heal plan rewrite (UpdateTest, queues
// one generation) and the eager `delete` self-delete (RemoveTest, a single assignment delete). Both are fast, but
// heartbeat for consistency with the other analysis activities.
export const selfHealAnalysisTest = withHeartbeat(selfHealAnalysisTestImpl);
export const deleteAnalysisTest = withHeartbeat(deleteAnalysisTestImpl);

// Compile-time check: ensure exported activities match the DiffsActivities contract.
({
    analyzeDiffs,
    markDiffsGenerating,
    finalizeDiffs,
    reviewGeneration,
    runHealingAgentForRefinement,
}) satisfies DiffsActivities;

// Compile-time check: the re-homed analysis-pipeline activities satisfy their contract. classify is part of the
// shared InvestigationActivities contract (the workflow proxy that calls it is typed against it); the diffs
// worker registers only that one method from it, so `Pick` rather than the full interface.
({
    runImpactAnalysis,
    reconcileAnalysis,
    finalizeAnalysis,
}) satisfies AnalysisActivities;
({ classifyInvestigationRun }) satisfies Pick<InvestigationActivities, "classifyInvestigationRun">;
// The Investigator's own row-local writes (self-heal + eager self-delete), on their own contract - only the diffs
// worker implements them, so they stay off the AnalysisActivities contract the frozen investigation worker shares.
({ selfHealAnalysisTest, deleteAnalysisTest }) satisfies InvestigatorActivities;
