import { describe, expect, test } from "vitest";
import { isAllowedOrigin } from "../../src/cors-origin-matcher";

describe("isAllowedOrigin", () => {
    test("matches configured origins exactly", () => {
        const allowedOrigins = "http://localhost:3000, https://app.autonoma.ai";

        expect(isAllowedOrigin("http://localhost:3000", allowedOrigins)).toBe(true);
        expect(isAllowedOrigin("https://app.autonoma.ai", allowedOrigins)).toBe(true);
    });

    test("rejects substring matches from comma-delimited env values", () => {
        const allowedOrigins = "https://good.example,https://another.example";

        expect(isAllowedOrigin("https://good.example.attacker.test", allowedOrigins)).toBe(false);
        expect(isAllowedOrigin("https://attacker.test/?next=https://good.example", allowedOrigins)).toBe(false);
    });

    test("accepts approved alpha preview domains", () => {
        const allowedOrigins = "http://localhost:3000";

        expect(isAllowedOrigin("https://alpha-deadbeef.alpha.agent.autonoma.app", allowedOrigins)).toBe(true);
        expect(isAllowedOrigin("https://alpha-deadbeef.agent.autonoma.app", allowedOrigins)).toBe(true);
    });
});
