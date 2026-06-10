import { AffectedReason, RunReviewVerdict } from "@autonoma/db";
import { type GenerationContext, sanitizeConversation, scenarioDataSchema } from "@autonoma/diffs";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { type CodebaseCoords, codebaseCoordsSchema } from "../framework";

/**
 * Frozen on-disk shape of a captured generation review case (`input.json`).
 *
 * Mirrors {@link GenerationContext} with two substitutions per the eval-case
 * contract: a live `Codebase` becomes {@link CodebaseCoords}, and the
 * `ModelMessage[]` conversation is stored verbatim *after* having been
 * sanitized at capture time (image parts + provider options stripped, so the
 * fixture stays text-only). All multimedia (screenshots + video) remains as
 * S3 keys - never bytes - and is rehydrated by the production evidence loader
 * at run time.
 *
 * `change`, `lineage`, and `scenario` are optional so cases captured before each
 * existed still parse; the changed-file list and diff hunks are never frozen here
 * - the reviewer derives them from the rehydrated codebase via `git diff`. The
 * `scenario` payload is the materialized generated-data graph, frozen verbatim.
 * `lineage` is present only for iteration-2+ cases (the refinement-loop
 * generations this fix targets) and absent for first-iteration and pre-lineage
 * cases.
 */
export const generationReviewCaseInputSchema = z.object({
    codebase: codebaseCoordsSchema,
    context: z.object({
        generationId: z.string(),
        organizationId: z.string(),
        selfReportedStatus: z.enum(["success", "failed", "running", "queued", "pending"]),
        testPlanPrompt: z.string(),
        conversation: z.array(z.custom<ModelMessage>()),
        reasoning: z.string().optional(),
        videoUrl: z.string().optional(),
        finalScreenshotKey: z.string().optional(),
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

export type GenerationReviewCaseInput = z.infer<typeof generationReviewCaseInputSchema>;

export interface RehydratedGenerationReviewInput {
    coords: CodebaseCoords;
    context: GenerationContext;
}

/**
 * Reconstruct the reviewer input from a parsed case. The codebase is returned
 * separately as coords for the caller to rehydrate via `ensureCachedCheckout`;
 * the context is otherwise the live shape the agent expects.
 */
export function rehydrateGenerationReviewInput(parsed: GenerationReviewCaseInput): RehydratedGenerationReviewInput {
    return { coords: parsed.codebase, context: parsed.context };
}

/**
 * Freeze a live {@link GenerationContext} into the on-disk case shape: replace
 * the live codebase reference with the given coords, and sanitize the
 * conversation so no inline image bytes are persisted. The reviewer's
 * `buildGenerationReviewMessages` calls `sanitizeConversation` again at
 * prompt-build time - idempotent, so sanitizing here keeps the fixture small
 * without changing what the agent eventually sees.
 */
export function serializeGenerationReviewInput(
    coords: CodebaseCoords,
    context: GenerationContext,
): GenerationReviewCaseInput {
    return generationReviewCaseInputSchema.parse({
        codebase: coords,
        context: {
            ...context,
            conversation: sanitizeConversation(context.conversation),
        },
    });
}
