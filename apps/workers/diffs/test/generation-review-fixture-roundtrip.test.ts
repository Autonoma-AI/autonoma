import type { GenerationContext } from "@autonoma/diffs";
import { describe, expect, it } from "vitest";
import type { CodebaseCoords } from "../evals/framework";
import {
    type GenerationReviewCaseInput,
    generationReviewCaseInputSchema,
    rehydrateGenerationReviewInput,
    serializeGenerationReviewInput,
} from "../evals/generation-review/generation-review-input";

const coords: CodebaseCoords = {
    owner: "acme",
    repo: "web",
    installationId: 42,
    baseSha: "base000",
    headSha: "head111",
};

describe("generation review fixture round-trip", () => {
    it("round-trips a context carrying change facts and lineage unchanged", () => {
        const context: GenerationContext = {
            generationId: "gen-1",
            organizationId: "org-1",
            selfReportedStatus: "failed",
            testPlanPrompt: "Sign up and reach the welcome screen",
            // String content survives sanitizeConversation untouched, so the
            // round-trip equality holds exactly.
            conversation: [
                { role: "assistant", content: "I typed the email" },
                { role: "user", content: "continue" },
            ],
            reasoning: "Form rejected the email",
            videoUrl: "generation/gen-1/video.webm",
            finalScreenshotKey: "generation/gen-1/final.jpeg",
            steps: [
                {
                    order: 0,
                    interaction: "type",
                    params: { target: "email" },
                    output: { success: true },
                    screenshotBeforeKey: "generation/gen-1/step-0-before.jpeg",
                },
            ],
            change: {
                baseSha: "base000",
                headSha: "head111",
                analysisReasoning: "Signup validation was rewritten.",
                affectedReason: "code_change",
                affectedReasoning: "This test fills out the signup form.",
            },
            lineage: {
                priorVerdicts: [{ iterationNumber: 1, verdict: "engine_error", reasoning: "Selector looked stale." }],
                planHistory: [
                    { iterationNumber: 1, prompt: "Click the old Submit button" },
                    {
                        iterationNumber: 2,
                        prompt: "Click the renamed Confirm button",
                        healingReasoning: "Renamed Submit to Confirm in the diff.",
                    },
                ],
            },
        };

        const frozen = serializeGenerationReviewInput(coords, context);
        // Survives a JSON disk trip (what capture writes / the eval reads back).
        const reparsed = generationReviewCaseInputSchema.parse(JSON.parse(JSON.stringify(frozen)));
        const { context: rehydrated } = rehydrateGenerationReviewInput(reparsed);

        expect(rehydrated).toEqual(context);
    });

    it("still parses a legacy fixture captured before change context and lineage existed", () => {
        const legacy: unknown = {
            codebase: coords,
            context: {
                generationId: "gen-legacy",
                organizationId: "org-1",
                selfReportedStatus: "failed",
                testPlanPrompt: "do the thing",
                conversation: [],
                steps: [],
            },
        };

        const parsed: GenerationReviewCaseInput = generationReviewCaseInputSchema.parse(legacy);
        const { context } = rehydrateGenerationReviewInput(parsed);

        expect(context.change).toBeUndefined();
        expect(context.lineage).toBeUndefined();
        expect(context.generationId).toBe("gen-legacy");
    });
});
