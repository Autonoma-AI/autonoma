import type { CheckpointPresentationSummary } from "@autonoma/types";
import { unresolvedBucketLabel } from "@autonoma/types";

/**
 * The word for the unresolved/in-flight test bucket, shared by the checkpoint
 * rail row, the test-run breakdown, and the snapshot-report header so the same
 * snapshot never reads "running" in one place and "awaiting review" in another.
 *
 * Delegates to the canonical `unresolvedBucketLabel` in `@autonoma/types` so the
 * UI and the GitHub PR comment use one definition.
 */
export function unresolvedLabel(executionState: CheckpointPresentationSummary["executionState"] | undefined): string {
    return unresolvedBucketLabel(executionState);
}
