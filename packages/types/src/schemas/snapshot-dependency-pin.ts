import { z } from "zod";

/**
 * The per-snapshot pinned dependency-SHA map: previewkit multirepo dependency
 * name -> the concrete commit SHA that dependency was deployed at when the
 * snapshot's grounding first ran. Pinned once (headSha-exact) and read by every
 * agent in the snapshot, so a later redeploy can not change what an in-flight
 * snapshot grounds against. The same dependency's pinned SHA on the previous
 * snapshot is the diff base for that dependency's checkout slice.
 */
export const snapshotDependencyShaMapSchema = z.record(z.string(), z.string());

export type SnapshotDependencyShaMap = z.infer<typeof snapshotDependencyShaMapSchema>;

/**
 * Degrade-safe reader for a snapshot's `pinnedDependencyShas` JSON column.
 * Returns an empty map for an unpinned snapshot (`null`) or any value that does
 * not parse as a string->string map - the pin never blocks a consumer, it only
 * narrows what code the agent can see.
 */
export function parseSnapshotDependencyShaMap(value: unknown): SnapshotDependencyShaMap {
    if (value == null) return {};
    const parsed = snapshotDependencyShaMapSchema.safeParse(value);
    return parsed.success ? parsed.data : {};
}
