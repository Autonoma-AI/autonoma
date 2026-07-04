import { logger as rootLogger } from "@autonoma/logger";
import type { InvestigationActivities } from "@autonoma/workflow/activities";
import { heartbeat } from "@temporalio/activity";
import { classifyInvestigationRun as classifyImpl } from "./classify-run";
import { diagnoseInvestigationScenario as diagnoseScenarioImpl } from "./diagnose-scenario";
import { markInvestigationProgress as markProgressImpl } from "./mark-progress";
import { mergeInvestigationEdits as mergeEditsImpl } from "./merge-edits";
import { persistInvestigationEdits as persistEditsImpl } from "./persist-edits";
import { postInvestigationPrComment as postPrCommentImpl } from "./post-pr-comment";
import { proposeRecipeRepair as proposeRecipeRepairImpl } from "./propose-recipe-repair";
import { reconcileInvestigationFindings as reconcileFindingsImpl } from "./reconcile-findings";
import { revertTwinRecipe as revertTwinRecipeImpl } from "./revert-twin-recipe";
import { selectInvestigationTests as selectImpl } from "./select-tests";
import { stageRecipeCandidateOnTwin as stageRecipeImpl } from "./stage-recipe-candidate";
import { createValidationGeneration as createValidationImpl } from "./validate-proposal";
import { writeInvestigationReport as writeReportImpl } from "./write-report";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Wrap a long-running investigation activity so it heartbeats every 30s while it works. These activities
 * (clone + LLM select, the classify reasoning loop, report) run for MINUTES inside a single async call and
 * cannot heartbeat internally - so without this, Temporal's heartbeatTimeout (2m on these activities) kills
 * any run longer than two minutes, which is most classifies. `heartbeat()` throws outside an activity context
 * (e.g. the local pipeline runner), so we stop the timer on the first such failure - a no-op everywhere else.
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

export const selectInvestigationTests = withHeartbeat(selectImpl);
export const classifyInvestigationRun = withHeartbeat(classifyImpl);
// One structured model call after loading the plan + recipe; heartbeat it so a slow call stays under the 2m timeout.
export const diagnoseInvestigationScenario = withHeartbeat(diagnoseScenarioImpl);
// Clones the repo + runs the tool-using repair agent (code/DB/backend queries + optional dry-run seeds) for
// MINUTES; heartbeat it so it stays well under the 2m heartbeat timeout like the other reasoning activities.
export const proposeRecipeRepair = withHeartbeat(proposeRecipeRepairImpl);
// Branch-scoped DB write (overwrites just the twin's recipe version) + a shadow generation; fast, but heartbeat
// for consistency with the other investigation activities.
export const stageRecipeCandidateOnTwin = withHeartbeat(stageRecipeImpl);
// A single branch-scoped DB write (restore the twin recipe version); fast, heartbeat for consistency.
export const revertTwinRecipe = withHeartbeat(revertTwinRecipeImpl);
// A single fast upsert of the report row's lifecycle fields; no heartbeat needed (well under any timeout).
export const markInvestigationProgress = markProgressImpl;
// Clones the repo + runs the tool-using reconciliation agent (finding navigation + code confirmation) for
// MINUTES; heartbeat it like the other reasoning activities so it stays under the 2m heartbeat timeout.
export const reconcileInvestigationFindings = withHeartbeat(reconcileFindingsImpl);
export const writeInvestigationReport = withHeartbeat(writeReportImpl);
export const createValidationGeneration = withHeartbeat(createValidationImpl);
export const postInvestigationPrComment = withHeartbeat(postPrCommentImpl);
// Loops over every modification + new test (bounded only by the affected-tests count), so heartbeat it like
// the other activities to stay well under the 2m heartbeat timeout on a large PR.
export const persistInvestigationEdits = withHeartbeat(persistEditsImpl);
// DB reads + one structured reconcile call; heartbeat it so a slow model call does not trip the 2m timeout.
export const mergeInvestigationEdits = withHeartbeat(mergeEditsImpl);

/** Compile-time guarantee that the exported activities satisfy the workflow's activity contract. */
const _activities: InvestigationActivities = {
    selectInvestigationTests,
    classifyInvestigationRun,
    diagnoseInvestigationScenario,
    proposeRecipeRepair,
    stageRecipeCandidateOnTwin,
    revertTwinRecipe,
    markInvestigationProgress,
    reconcileInvestigationFindings,
    writeInvestigationReport,
    createValidationGeneration,
    postInvestigationPrComment,
    persistInvestigationEdits,
    mergeInvestigationEdits,
};
void _activities;
