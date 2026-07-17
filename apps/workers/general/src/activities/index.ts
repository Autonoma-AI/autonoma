import type { GeneralActivities } from "@autonoma/workflow/activities";

export { scenarioUp, scenarioDown } from "./scenario";
export { notifyGenerationExit } from "./notify-generation-exit";
export { markGenerationFailed } from "./mark-generation-failed";
export { applyHealingActions } from "./healing";
export {
    analyzeResults,
    finishRefinementIteration,
    finishErroredRefinementIterations,
    finishRefinementLoop,
    initRefinementLoop,
    markRefinementIterationRunning,
    prepareGenerationQueue,
    finalizePendingSnapshot,
} from "./refinement";

import { applyHealingActions } from "./healing";
import { markGenerationFailed } from "./mark-generation-failed";
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
} from "./refinement";
import { scenarioDown, scenarioUp } from "./scenario";

// Compile-time check: ensure exported activities match the GeneralActivities contract.
({
    scenarioUp,
    scenarioDown,
    notifyGenerationExit,
    markGenerationFailed,
    applyHealingActions,
    analyzeResults,
    initRefinementLoop,
    markRefinementIterationRunning,
    finishRefinementIteration,
    finishErroredRefinementIterations,
    finishRefinementLoop,
    prepareGenerationQueue,
    finalizePendingSnapshot,
}) satisfies GeneralActivities;
