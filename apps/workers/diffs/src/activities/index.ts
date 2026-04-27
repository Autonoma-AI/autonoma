import type { DiffsActivities } from "@autonoma/workflow/activities";

export { analyzeDiffs } from "./analyze-diffs";
export { resolveDiffs } from "./resolve-diffs";
export { finalizeDiffs } from "./finalize-diffs";

import { analyzeDiffs } from "./analyze-diffs";
import { finalizeDiffs } from "./finalize-diffs";
import { resolveDiffs } from "./resolve-diffs";

// Compile-time check: ensure exported activities match the DiffsActivities contract.
({ analyzeDiffs, resolveDiffs, finalizeDiffs }) satisfies DiffsActivities;
