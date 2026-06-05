import type { GeneralActivities } from "@autonoma/workflow/activities";

export { scenarioUp, scenarioDown } from "./scenario";
export { assignGenerationResults } from "./assign-generation-results";
export { notifyGenerationExit } from "./notify-generation-exit";
export { markGenerationFailed } from "./mark-generation-failed";
export { markRunFailed } from "./mark-run-failed";
export { applyHealingActions } from "./healing";
export {
    analyzeResults,
    finishRefinementIteration,
    finishErroredRefinementIterations,
    finishRefinementLoop,
    initRefinementLoop,
    markRefinementIterationRunning,
    prepareGenerationQueue,
    prepareRunsForGenerations,
    finalizePendingSnapshot,
} from "./refinement";

import { assignGenerationResults } from "./assign-generation-results";
import { applyHealingActions } from "./healing";
import { markGenerationFailed } from "./mark-generation-failed";
import { markRunFailed } from "./mark-run-failed";
import { notifyGenerationExit } from "./notify-generation-exit";
import {
    analyzeResults,
    finalizePendingSnapshot,
    finishErroredRefinementIterations,
    finishRefinementIteration,
    finishRefinementLoop,
    initRefinementLoop,
    markRefinementIterationRunning,
    prepareGenerationQueue,
    prepareRunsForGenerations,
} from "./refinement";
import { scenarioDown, scenarioUp } from "./scenario";

// Compile-time check: ensure exported activities match the GeneralActivities contract.
({
    scenarioUp,
    scenarioDown,
    assignGenerationResults,
    notifyGenerationExit,
    markGenerationFailed,
    markRunFailed,
    applyHealingActions,
    analyzeResults,
    initRefinementLoop,
    markRefinementIterationRunning,
    finishRefinementIteration,
    finishErroredRefinementIterations,
    finishRefinementLoop,
    prepareGenerationQueue,
    prepareRunsForGenerations,
    finalizePendingSnapshot,
}) satisfies GeneralActivities;
