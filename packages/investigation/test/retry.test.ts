import { describe, expect, it } from "vitest";
import { withRetry } from "../src/retry";

/** Mimics the AI SDK's no-output error: the model finished but emitted no parseable structured output. */
class NoOutputError extends Error {
    constructor() {
        super("No output generated.");
        this.name = "AI_NoOutputGeneratedError";
    }
}

describe("withRetry", () => {
    it("retries an AI no-output error and returns the eventual success", async () => {
        let calls = 0;
        const result = await withRetry(
            async () => {
                calls += 1;
                if (calls === 1) throw new NoOutputError();
                return "ok";
            },
            { tries: 3 },
        );
        expect(result).toBe("ok");
        expect(calls).toBe(2);
    });

    it("does not retry a genuine logic error", async () => {
        let calls = 0;
        await expect(
            withRetry(async () => {
                calls += 1;
                throw new Error("slug not found in catalog");
            }),
        ).rejects.toThrow("slug not found");
        expect(calls).toBe(1);
    });
});
