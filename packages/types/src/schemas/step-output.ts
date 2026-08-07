import { z } from "zod";

const pointSchema = z.object({ x: z.number(), y: z.number() });

/** Boundary parser for the JSON stored in StepOutput.output. */
export const stepOutputDataSchema = z.object({
    outcome: z.string().optional(),
    point: pointSchema.optional(),
    startPoint: pointSchema.optional(),
    endPoint: pointSchema.optional(),
});
