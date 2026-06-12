import { z } from "zod";
import { REPLAY_WEB_INTERACTIONS } from "../../src/replay/web-command-spec";
import { generationEvalInputSchema } from "../generation/generation-input";

/**
 * A single frozen step from a recorded generation, as stored in `input.json`.
 */
export const frozenStepSchema = z.object({
    interaction: z.enum(REPLAY_WEB_INTERACTIONS),
    params: z.record(z.string(), z.unknown()),
    waitCondition: z.string().optional(),
});

export type FrozenStep = z.infer<typeof frozenStepSchema>;

/**
 * Frozen on-disk shape of a captured replay eval case (`input.json`).
 *
 * Extends GenerationEvalInput with the recorded steps so the replay harness
 * can execute them against the live app without a database.
 */
export const replayEvalInputSchema = generationEvalInputSchema.extend({
    runId: z.string().optional(),
    steps: z.array(frozenStepSchema),
});

export type ReplayEvalInput = z.infer<typeof replayEvalInputSchema>;
