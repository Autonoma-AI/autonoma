import type { RouterOutputs } from "lib/trpc";

type CheckpointSource = RouterOutputs["branches"]["snapshotHistory"][number]["source"];

/**
 * Keyed by the router output rather than a hand-listed union, so adding a trigger source server-side is a
 * type error here instead of a checkpoint rendering a raw enum name at a customer.
 */
const TRIGGER_LABELS: Record<CheckpointSource, string> = {
    GITHUB_PUSH: "on push",
    MANUAL: "run by hand",
    WEBHOOK: "via webhook",
};

export function checkpointTriggerLabel(source: CheckpointSource): string {
    return TRIGGER_LABELS[source];
}
