import type { RunContext } from "@autonoma/diffs";
import { describe, expect, it } from "vitest";
import type { CodebaseCoords } from "../evals/framework";
import {
    type ReplayReviewCaseInput,
    rehydrateReplayReviewInput,
    replayReviewCaseInputSchema,
    serializeReplayReviewInput,
} from "../evals/replay-review/replay-review-input";

const coords: CodebaseCoords = {
    owner: "acme",
    repo: "web",
    installationId: 42,
    baseSha: "base000",
    headSha: "head111",
};

describe("replay review fixture round-trip", () => {
    it("round-trips a context carrying full change facts unchanged", () => {
        const context: RunContext = {
            runId: "run-1",
            organizationId: "org-1",
            testPlanPrompt: "Log in and reach the dashboard",
            testCaseName: "Login flow",
            steps: [
                {
                    order: 0,
                    interaction: "click",
                    params: { target: "submit" },
                    output: { outcome: "element_not_found" },
                    screenshotBeforeKey: "run/run-1/step-0-before.jpeg",
                },
            ],
            videoS3Key: "run/run-1/video.webm",
            finalScreenshotKey: "run/run-1/step-0-before.jpeg",
            change: {
                baseSha: "base000",
                headSha: "head111",
                analysisReasoning: "The submit button id changed.",
                affectedReason: "code_change",
                affectedReasoning: "This test clicks the renamed submit button.",
            },
        };

        const frozen = serializeReplayReviewInput(coords, context);
        // Survives a JSON disk trip (what capture writes / the eval reads back).
        const reparsed = replayReviewCaseInputSchema.parse(JSON.parse(JSON.stringify(frozen)));
        const { context: rehydrated } = rehydrateReplayReviewInput(reparsed);

        expect(rehydrated).toEqual(context);
    });

    it("still parses a legacy fixture captured before change context existed", () => {
        const legacy: unknown = {
            codebase: coords,
            context: {
                runId: "run-legacy",
                organizationId: "org-1",
                testPlanPrompt: "do the thing",
                testCaseName: "Legacy case",
                steps: [],
            },
        };

        const parsed: ReplayReviewCaseInput = replayReviewCaseInputSchema.parse(legacy);
        const { context } = rehydrateReplayReviewInput(parsed);

        expect(context.change).toBeUndefined();
        expect(context.runId).toBe("run-legacy");
    });
});
