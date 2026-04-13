import type { GeneralActivities } from "@autonoma/workflow/activities";

export { scenarioUp, scenarioDown } from "./scenario";
export { reviewGeneration, reviewReplay } from "./review";
export { assignGenerationResults } from "./assign-generation-results";
export { notifyGenerationExit } from "./notify-generation-exit";
export { analyzeDiffs } from "./analyze-diffs";
export { markGenerationFailed } from "./mark-generation-failed";

import { analyzeDiffs } from "./analyze-diffs";
import { assignGenerationResults } from "./assign-generation-results";
import { markGenerationFailed } from "./mark-generation-failed";
import { notifyGenerationExit } from "./notify-generation-exit";
import { reviewGeneration } from "./review";
import { reviewReplay } from "./review";
// Compile-time check: ensure exported activities match the GeneralActivities contract.
import { scenarioUp } from "./scenario";
import { scenarioDown } from "./scenario";

({
    scenarioUp,
    scenarioDown,
    reviewGeneration,
    reviewReplay,
    assignGenerationResults,
    notifyGenerationExit,
    analyzeDiffs,
    markGenerationFailed,
}) satisfies GeneralActivities;
