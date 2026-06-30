import { describe, expect, it } from "vitest";
import { CreateTestTool, MIN_DESCRIPTION_LENGTH, createTestSchema } from "../src/agents/diffs/tools/create-test-tool";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeDiffsLoop } from "./test-loops";

const meaningfulDescription =
    "A shopper applying a valid promo code at checkout sees the order total drop by the discount amount.";

function validInput(overrides: { description?: string; coverageJustification?: string } = {}) {
    return {
        name: "Checkout promo flow",
        folderName: "All Tests",
        description: overrides.description ?? meaningfulDescription,
        plan: "Apply a promo code at checkout and assert the discounted total.",
        coverageJustification:
            overrides.coverageJustification ?? "No existing test exercises the promo-code field this diff adds.",
    };
}

describe("createTestSchema description", () => {
    it("accepts a meaningful description", () => {
        const result = createTestSchema.safeParse(validInput());
        expect(result.success).toBe(true);
    });

    it("rejects an empty description", () => {
        const result = createTestSchema.safeParse(validInput({ description: "" }));
        expect(result.success).toBe(false);
    });

    it("rejects a whitespace-only description of sufficient raw length", () => {
        const result = createTestSchema.safeParse(validInput({ description: " ".repeat(MIN_DESCRIPTION_LENGTH + 5) }));
        expect(result.success).toBe(false);
    });

    it("rejects a trivial description shorter than the minimum", () => {
        const result = createTestSchema.safeParse(validInput({ description: "promo" }));
        expect(result.success).toBe(false);
    });
});

describe("createTestSchema coverageJustification", () => {
    it("remains a required field", () => {
        const result = createTestSchema.safeParse(validInput({ coverageJustification: "" }));
        expect(result.success).toBe(false);
    });

    it("is the dedup gate, distinct from description, and is not length-checked beyond non-empty", () => {
        const result = createTestSchema.safeParse(validInput({ coverageJustification: "new flow" }));
        expect(result.success).toBe(true);
    });
});

describe("create_test tool", () => {
    it("records a created test that carries the meaningful description as its durable intent", async () => {
        const loop = makeDiffsLoop();
        const tool = new CreateTestTool();

        const result = await executeTool<ToolEnvelope<{ testName: string }>>(tool, validInput(), loop);

        expect(result.success).toBe(true);
        expect(loop.createdTests).toHaveLength(1);
        const created = loop.createdTests[0];
        expect(created?.description.trim().length).toBeGreaterThanOrEqual(MIN_DESCRIPTION_LENGTH);
    });
});
