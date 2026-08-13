import { describe, expect, test } from "vitest";
import { isPlaceholderCredential } from "../../src/core/placeholder-credential";

/**
 * The values in these tests are the ones our own pages have handed people. A
 * placeholder token authenticates nothing, so every request 401s - and a 401
 * from the LLM proxy reaches the agent as a fatal error carrying no message at
 * all, which is unreadable for the user and invisible to us. Catching it at
 * startup is only worth anything if it catches what the docs actually print.
 */
describe("placeholders the docs hand out", () => {
    test.each([
        ["...", "the ellipsis every snippet used"],
        ["…", "the same after typographic conversion"],
        ["•".repeat(24), "the mask the connect screen renders"],
        ["<api-token>", "an angle-wrapped stand-in"],
        ["${AUTONOMA_API_TOKEN}", "an unexpanded shell variable"],
        ["{{api_token}}", "a template stand-in"],
        ["YOUR_DISTINCT_ID", "a shouted stand-in"],
        ["your_generation_id_here", "a written stand-in"],
        ["   ", "whitespace only"],
    ])("rejects %j - %s", (value) => {
        expect(isPlaceholderCredential(value)).toBe(true);
    });
});

describe("credentials that must survive", () => {
    test.each([
        [`ask_${"a1b2c3d4".repeat(8)}`, "a real API key"],
        [`n${"9f8e7d6c".repeat(8)}`, "a Vercel-minted key, which carries no ask_ prefix"],
        ["ask_test", "the short token our own tests run on"],
    ])("accepts %j - %s", (value) => {
        expect(isPlaceholderCredential(value)).toBe(false);
    });
});
