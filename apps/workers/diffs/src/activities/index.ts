import type { DiffsActivities } from "@autonoma/workflow/activities";

export { analyzeDiffs } from "./analyze-diffs";
export { markDiffsGenerating } from "./mark-diffs-generating";
export { finalizeDiffs } from "./finalize-diffs";
export { reviewGeneration } from "./review/generation";
export { reviewReplay } from "./review/replay";
export { runHealingAgentForRefinement } from "./refinement/run-healing-agent";

import { analyzeDiffs } from "./analyze-diffs";
import { finalizeDiffs } from "./finalize-diffs";
import { markDiffsGenerating } from "./mark-diffs-generating";
import { runHealingAgentForRefinement } from "./refinement/run-healing-agent";
import { reviewGeneration } from "./review/generation";
import { reviewReplay } from "./review/replay";

// Compile-time check: ensure exported activities match the DiffsActivities contract.
({
    analyzeDiffs,
    markDiffsGenerating,
    finalizeDiffs,
    reviewGeneration,
    reviewReplay,
    runHealingAgentForRefinement,
}) satisfies DiffsActivities;
