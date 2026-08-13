import { z } from "zod";

/**
 * Where the cause of a failed rollout is actually visible.
 *
 * The whole point of naming it: a preview that built in nine seconds and then crashlooped used
 * to be reported as "Build failed", which sends the reader to the one stream that has nothing
 * wrong in it. Each explanation carries the tab that holds its answer.
 */
export const deployFailureEvidenceSourceSchema = z.enum(["app_logs", "build_logs", "config"]);

export type DeployFailureEvidenceSource = z.infer<typeof deployFailureEvidenceSourceSchema>;

/**
 * A deploy failure said in words a person can act on, with the original message kept.
 *
 * `technicalDetail` is the raw text the platform produced - a Kubernetes rollout error carrying
 * pod hashes and a namespace UUID. It is retained rather than dropped because it is what an
 * engineer pastes into a search or hands to support; it just stops being the headline.
 */
export const deployFailureExplanationSchema = z.object({
    title: z.string(),
    explanation: z.string(),
    lookIn: deployFailureEvidenceSourceSchema,
    technicalDetail: z.string(),
});

export type DeployFailureExplanation = z.infer<typeof deployFailureExplanationSchema>;
