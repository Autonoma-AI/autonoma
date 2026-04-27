import type { GeneralActivities } from "@autonoma/workflow/activities";

export { scenarioUp, scenarioDown } from "./scenario";
export { reviewGeneration, reviewReplay } from "./review";
export { assignGenerationResults } from "./assign-generation-results";
export { notifyGenerationExit } from "./notify-generation-exit";
export { markGenerationFailed } from "./mark-generation-failed";

import { assignGenerationResults } from "./assign-generation-results";
import { markGenerationFailed } from "./mark-generation-failed";
import { notifyGenerationExit } from "./notify-generation-exit";
import { reviewGeneration, reviewReplay } from "./review";
import { scenarioDown, scenarioUp } from "./scenario";

// Compile-time check: ensure exported activities match the GeneralActivities contract.
({
    scenarioUp,
    scenarioDown,
    reviewGeneration,
    reviewReplay,
    assignGenerationResults,
    notifyGenerationExit,
    markGenerationFailed,
}) satisfies GeneralActivities;
