import { z } from "zod";
import { failurePointSchema, reviewEvidenceSchema } from "./generation-verdict";

/**
 * Boundary parser for the JSON stored in RunReview.analysis / GenerationReview.analysis.
 * Only the fields the evidence-first bug detail needs are validated; everything else is ignored.
 */
export const runAnalysisSchema = z.object({
    failurePoint: failurePointSchema.optional(),
    evidence: z.array(reviewEvidenceSchema).default([]),
});

const pointSchema = z.object({ x: z.number(), y: z.number() });

/** Boundary parser for the JSON stored in StepOutput.output. */
export const stepOutputDataSchema = z.object({
    outcome: z.string().optional(),
    point: pointSchema.optional(),
    startPoint: pointSchema.optional(),
    endPoint: pointSchema.optional(),
});

export const bugOccurrenceSchema = z.object({
    issueId: z.string(),
    source: z.enum(["run", "generation"]),
    runId: z.string().optional(),
    generationId: z.string().optional(),
    createdAt: z.date(),
    isLatest: z.boolean(),
    snapshotId: z.string().optional(),
    sha: z.string().optional(),
    prNumber: z.number().optional(),
    branchName: z.string().optional(),
});
export type BugOccurrenceEntry = z.infer<typeof bugOccurrenceSchema>;
