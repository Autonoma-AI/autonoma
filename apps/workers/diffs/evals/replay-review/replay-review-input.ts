import { AffectedReason, RunReviewVerdict } from "@autonoma/db";
import { type RunContext, scenarioDataSchema } from "@autonoma/diffs";
import { z } from "zod";
import { type CodebaseCoords, codebaseCoordsSchema } from "../framework";

/**
 * Frozen on-disk shape of a captured replay review case (`input.json`).
 *
 * Mirrors {@link RunContext} with the same substitution as Analysis and
 * generation-review: a live `Codebase` becomes {@link CodebaseCoords}, all
 * multimedia (step screenshots + final screenshot + run video) stays as S3
 * keys - never bytes - and is rehydrated by the production evidence loader
 * at run time. Unlike generation-review, replay has no agent conversation to
 * sanitize: the context is purely the executed steps + the test case + the
 * DB-sourced change facts.
 *
 * `change`, `lineage`, and `scenario` are optional so cases captured before each
 * existed still parse; the changed-file list and diff hunks are never frozen here
 * - the reviewer derives them from the rehydrated codebase via `git diff`. The
 * `scenario` payload is the materialized generated-data graph, frozen verbatim.
 * `lineage` is present only for iteration-2+ cases (the refinement-loop runs this
 * fix targets) and absent for first-iteration and pre-lineage cases.
 */
export const replayReviewCaseInputSchema = z.object({
    codebase: codebaseCoordsSchema,
    context: z.object({
        runId: z.string(),
        organizationId: z.string(),
        testPlanPrompt: z.string(),
        testCaseName: z.string(),
        steps: z.array(
            z.object({
                order: z.number().int().nonnegative(),
                interaction: z.string(),
                params: z.unknown(),
                output: z.unknown(),
                screenshotBeforeKey: z.string().optional(),
                screenshotAfterKey: z.string().optional(),
            }),
        ),
        videoS3Key: z.string().optional(),
        finalScreenshotKey: z.string().optional(),
        change: z
            .object({
                baseSha: z.string(),
                headSha: z.string(),
                analysisReasoning: z.string().optional(),
                affectedReason: z.enum(AffectedReason).optional(),
                affectedReasoning: z.string().optional(),
            })
            .optional(),
        lineage: z
            .object({
                priorVerdicts: z.array(
                    z.object({
                        iterationNumber: z.number().int().positive(),
                        verdict: z.enum(RunReviewVerdict),
                        reasoning: z.string(),
                    }),
                ),
                planHistory: z.array(
                    z.object({
                        iterationNumber: z.number().int().positive(),
                        prompt: z.string(),
                        healingReasoning: z.string().optional(),
                    }),
                ),
            })
            .optional(),
        scenario: scenarioDataSchema.optional(),
    }),
});

export type ReplayReviewCaseInput = z.infer<typeof replayReviewCaseInputSchema>;

export interface RehydratedReplayReviewInput {
    coords: CodebaseCoords;
    context: RunContext;
}

/**
 * Reconstruct the reviewer input from a parsed case. The codebase is returned
 * separately as coords for the caller to rehydrate via `ensureCachedCheckout`;
 * the context is otherwise the live shape the agent expects.
 */
export function rehydrateReplayReviewInput(parsed: ReplayReviewCaseInput): RehydratedReplayReviewInput {
    return { coords: parsed.codebase, context: parsed.context };
}

/**
 * Freeze a live {@link RunContext} into the on-disk case shape: replace the
 * live codebase reference with the given coords. Multimedia remains as S3
 * keys.
 */
export function serializeReplayReviewInput(coords: CodebaseCoords, context: RunContext): ReplayReviewCaseInput {
    return replayReviewCaseInputSchema.parse({
        codebase: coords,
        context,
    });
}
