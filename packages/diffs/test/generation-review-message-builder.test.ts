import { describe, expect, it } from "vitest";
import { buildGenerationReviewMessages } from "../src/review/generation/message-builder";
import type { GenerationContext } from "../src/review/generation/types";

/** Minimal generation context; individual tests layer change/lineage on top. */
function baseContext(overrides: Partial<GenerationContext> = {}): GenerationContext {
    return {
        generationId: "gen-1",
        organizationId: "org-1",
        selfReportedStatus: "failed",
        testPlanPrompt: "Sign up and reach the welcome screen",
        conversation: [{ role: "assistant", content: "I typed the email" }],
        steps: [
            {
                order: 0,
                interaction: "type",
                params: { target: "email" },
                status: "success",
                output: { outcome: "success" },
            },
        ],
        ...overrides,
    };
}

/** Concatenate every text part of the leading mixed-content user message. */
function leadingText(messages: ReturnType<typeof buildGenerationReviewMessages>): string {
    const first = messages[0]!;
    const parts = first.content as Array<{ type: string; text?: string }>;
    return parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n\n");
}

describe("buildGenerationReviewMessages", () => {
    it("renders the change-context section with a git diff command when change is present", () => {
        const messages = buildGenerationReviewMessages(
            baseContext({
                change: {
                    baseSha: "base000",
                    headSha: "head111",
                    analysisReasoning: "Signup validation was rewritten.",
                    affectedReason: "code_change",
                    affectedReasoning: "This test fills out the signup form.",
                },
            }),
            undefined,
        );

        const text = leadingText(messages);
        expect(text).toContain("## Code Change Under Review");
        expect(text).toContain("git diff base000..head111");
        // Generation framing names the generation-specific verdict choice.
        expect(text).toContain("plan_mismatch");
        expect(text).toContain("agent_limitation");
        expect(text).toContain("### Change Analysis");
        expect(text).toContain("Signup validation was rewritten.");
        expect(text).toContain("### Why This Test Was Flagged");
        expect(text).toContain("This test fills out the signup form.");
    });

    it("omits the change-context section when change is absent", () => {
        const text = leadingText(buildGenerationReviewMessages(baseContext(), undefined));
        expect(text).not.toContain("## Code Change Under Review");
        expect(text).not.toContain("git diff");
    });

    it("renders the lineage plan-delta and the anchoring guard when lineage is present", () => {
        const messages = buildGenerationReviewMessages(
            baseContext({
                lineage: {
                    priorVerdicts: [
                        { iterationNumber: 1, verdict: "engine_error", reasoning: "Selector looked stale." },
                    ],
                    planHistory: [
                        { iterationNumber: 1, prompt: "Click the old Submit button" },
                        {
                            iterationNumber: 2,
                            prompt: "Click the renamed Confirm button",
                            healingReasoning: "Renamed Submit to Confirm in the diff.",
                        },
                    ],
                },
            }),
            undefined,
        );

        const text = leadingText(messages);
        expect(text).toContain("## Refinement-Loop History (fallible signal)");
        expect(text).toContain("### Plan Changes");
        // Generation-specific subject noun.
        expect(text).toContain("The generation you are reviewing executed the **current** plan");
        expect(text).toContain("Previous plan (iteration 1)");
        expect(text).toContain("Current plan (iteration 2");
        expect(text).toContain("Renamed Submit to Confirm in the diff.");
        expect(text).toContain("### Prior Verdicts On This Test");
        expect(text).toContain("**Iteration 1** judged this `engine_error`");
        // The anchoring guard: prior verdicts are a fallible lead, not the answer.
        expect(text).toContain("fallible lead to investigate, never as the answer");
    });

    it("omits the lineage section when lineage is absent", () => {
        const text = leadingText(buildGenerationReviewMessages(baseContext(), undefined));
        expect(text).not.toContain("## Refinement-Loop History");
    });

    it("renders the bounded scenario-data summary when scenario data is present", () => {
        const messages = buildGenerationReviewMessages(
            baseContext({
                scenario: {
                    scenarioName: "Single org with one project",
                    entities: {
                        User: [{ _alias: "owner", email: "owner@example.test", name: "Pat Owner" }],
                        Project: [{ _alias: "proj", name: "Apollo", ownerId: { _ref: "owner" } }],
                    },
                },
            }),
            undefined,
        );

        const text = leadingText(messages);
        expect(text).toContain("## Scenario Data");
        expect(text).toContain("Single org with one project");
        // Entity types and their aliases surface in the bounded summary.
        expect(text).toContain("User");
        expect(text).toContain("owner");
        expect(text).toContain("Project");
        expect(text).toContain("Apollo");
    });

    it("omits the scenario-data section when scenario data is absent", () => {
        const text = leadingText(buildGenerationReviewMessages(baseContext(), undefined));
        expect(text).not.toContain("## Scenario Data");
    });

    it("always splices the sanitized agent conversation after the context", () => {
        const messages = buildGenerationReviewMessages(baseContext(), undefined);
        // The conversation message follows the leading context message.
        expect(messages.some((m) => m.role === "assistant" && m.content === "I typed the email")).toBe(true);
        const last = messages[messages.length - 1]!;
        expect(last.role).toBe("user");
        expect(typeof last.content).toBe("string");
    });
});
