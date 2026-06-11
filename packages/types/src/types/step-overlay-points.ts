import { z } from "zod";

/** A step interaction point tagged with its role: the click/type target, or a drag's start/end. */
export type OverlayPoint = { x: number; y: number; role: "click" | "drag-start" | "drag-end" };

const pointSchema = z.object({ x: z.number(), y: z.number() });

const outputWithPointsSchema = z
    .object({
        point: pointSchema.optional(),
        startPoint: pointSchema.optional(),
        endPoint: pointSchema.optional(),
    })
    .passthrough();

/**
 * Extract a step output's resolved interaction points, tagged with their role.
 * Returns an empty array for outputs that carry no points (or aren't point-bearing),
 * so callers can pass any step output. Shared by the UI overlay and the reviewer's
 * server-side screenshot annotation.
 */
export function getStepOverlayPoints(output: unknown): OverlayPoint[] {
    const parsed = outputWithPointsSchema.safeParse(output);
    if (!parsed.success) return [];

    const points: OverlayPoint[] = [];
    if (parsed.data.point != null) points.push({ ...parsed.data.point, role: "click" });
    if (parsed.data.startPoint != null) points.push({ ...parsed.data.startPoint, role: "drag-start" });
    if (parsed.data.endPoint != null) points.push({ ...parsed.data.endPoint, role: "drag-end" });
    return points;
}
