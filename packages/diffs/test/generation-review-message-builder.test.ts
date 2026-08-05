import { describe, expect, it } from "vitest";
import { buildGenerationReviewMessages } from "../src/review/generation/message-builder";
import type { GenerationContext } from "../src/review/generation/types";

/** Minimal generation context with the always-present `change`; tests layer scenario data on top. */
function baseContext(overrides: Partial<GenerationContext> = {}): GenerationContext {
    return {
        generationId: "gen-1",
        organizationId: "org-1",
        testCaseName: "Sign up",
        selfReportedStatus: "failed",
        testPlanPrompt: "Sign up and reach the welcome screen",
        conversation: [{ role: "assistant", content: "I typed the email" }],
        change: { baseSha: "base000", headSha: "head111" },
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
            baseContext({ change: { baseSha: "base000", headSha: "head111" } }),
            undefined,
        );

        const text = leadingText(messages);
        expect(text).toContain("## Code Change Under Review");
        expect(text).toContain("git diff base000..head111");
        // Generation framing names the generation-specific verdict choice.
        expect(text).toContain("plan_mismatch");
        expect(text).toContain("agent_limitation");
    });

    it("throws when change is absent - the reviewer requires the diff anchor", () => {
        const context = baseContext();
        delete context.change;
        expect(() => buildGenerationReviewMessages(context, undefined)).toThrow(/requires change context/);
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
