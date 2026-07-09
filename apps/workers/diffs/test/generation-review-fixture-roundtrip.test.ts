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
            testCaseName: "Sign up",
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
                    status: "success",
                    output: { outcome: "success", point: { x: 12, y: 34 } },
                    screenshotBeforeKey: "generation/gen-1/step-0-before.jpeg",
                },
                {
                    order: 1,
                    interaction: "click",
                    params: { target: "submit" },
                    status: "failed",
                    error: "could not find element matching 'submit'",
                    errorName: "ElementNotFoundError",
                    screenshotBeforeKey: "generation/gen-1/attempt-1-before.jpeg",
                },
            ],
            change: {
                baseSha: "base000",
                headSha: "head111",
                analysisReasoning: "Signup validation was rewritten.",
                affectedReason: "code_change",
                affectedReasoning: "This test fills out the signup form.",
            },
            lineage: [
                {
                    iterationNumber: 1,
                    prompt: "Click the old Submit button",
                    verdicts: [{ verdict: "unknown_issue", reasoning: "Selector looked stale." }],
                },
                {
                    iterationNumber: 2,
                    prompt: "Click the renamed Confirm button",
                    healingReasoning: "Renamed Submit to Confirm in the diff.",
                    verdicts: [],
                },
            ],
        };

        const frozen = serializeGenerationReviewInput(coords, context);
        // Survives a JSON disk trip (what capture writes / the eval reads back).
        const reparsed = generationReviewCaseInputSchema.parse(JSON.parse(JSON.stringify(frozen)));
        const { context: rehydrated } = rehydrateGenerationReviewInput(reparsed);

        expect(rehydrated).toEqual(context);
    });

    it("round-trips a context carrying materialized scenario data unchanged", () => {
        const context: GenerationContext = {
            generationId: "gen-2",
            organizationId: "org-1",
            selfReportedStatus: "failed",
            testCaseName: "Open first project",
            testPlanPrompt: "Open the first project and verify its name",
            conversation: [{ role: "assistant", content: "I opened the project list" }],
            steps: [],
            change: { baseSha: "base000", headSha: "head111", analysisReasoning: "Project view markup changed." },
            lineage: [],
            scenario: {
                scenarioName: "Single org with one project",
                entities: {
                    User: [{ _alias: "owner", email: "owner@example.test", name: "Pat Owner" }],
                    Project: [
                        { _alias: "proj", name: "Apollo", ownerId: { _ref: "owner" } },
                        { _alias: "proj2", name: "Gemini", ownerId: { _ref: "owner" } },
                    ],
                },
            },
        };

        const frozen = serializeGenerationReviewInput(coords, context);
        const reparsed = generationReviewCaseInputSchema.parse(JSON.parse(JSON.stringify(frozen)));
        const { context: rehydrated } = rehydrateGenerationReviewInput(reparsed);

        expect(rehydrated).toEqual(context);
    });

    it("parses a legacy fixture with no lineage and defaults status-less steps to success", () => {
        const legacy: unknown = {
            codebase: coords,
            context: {
                generationId: "gen-legacy",
                organizationId: "org-1",
                selfReportedStatus: "failed",
                testPlanPrompt: "do the thing",
                conversation: [],
                change: { baseSha: "base000", headSha: "head111" },
                // Steps captured before the attempt timeline had no `status`; every
                // persisted step was a success, so the default must recover that.
                steps: [{ order: 0, interaction: "click", params: { target: "x" }, output: { outcome: "success" } }],
            },
        };

        const parsed: GenerationReviewCaseInput = generationReviewCaseInputSchema.parse(legacy);
        const { context } = rehydrateGenerationReviewInput(parsed);

        expect(context.change?.analysisReasoning).toBe("");
        expect(context.lineage).toEqual([]);
        expect(context.generationId).toBe("gen-legacy");
        expect(context.steps[0]?.status).toBe("success");
    });

    it("rejects a fixture missing change context - the reviewer requires the diff anchor", () => {
        const noChange: unknown = {
            codebase: coords,
            context: {
                generationId: "gen-no-change",
                organizationId: "org-1",
                selfReportedStatus: "failed",
                testPlanPrompt: "do the thing",
                conversation: [],
                steps: [],
            },
        };

        expect(() => generationReviewCaseInputSchema.parse(noChange)).toThrow();
    });
});
