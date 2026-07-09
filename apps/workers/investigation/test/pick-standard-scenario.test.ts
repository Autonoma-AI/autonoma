import { describe, expect, it } from "vitest";
import { pickStandardScenario } from "../src/activities/pick-standard-scenario";

describe("pickStandardScenario", () => {
    it("prefers a scenario named 'standard' even when others exist", () => {
        const chosen = pickStandardScenario([
            { id: "a", name: "onboarding" },
            { id: "b", name: "standard" },
            { id: "c", name: "empty" },
        ]);
        expect(chosen?.id).toBe("b");
    });

    it("matches 'standard' case-insensitively and trims surrounding whitespace", () => {
        expect(pickStandardScenario([{ id: "x", name: "  Standard " }])?.id).toBe("x");
        expect(pickStandardScenario([{ id: "y", name: "STANDARD" }])?.id).toBe("y");
    });

    it("falls back to the sole scenario when there is exactly one and none is named 'standard'", () => {
        expect(pickStandardScenario([{ id: "only", name: "production-like" }])?.id).toBe("only");
    });

    it("returns undefined when several scenarios exist and none is named 'standard' (ambiguous - stay unseeded)", () => {
        const chosen = pickStandardScenario([
            { id: "a", name: "onboarding" },
            { id: "b", name: "empty" },
        ]);
        expect(chosen).toBeUndefined();
    });

    it("returns undefined when the app has no scenarios", () => {
        expect(pickStandardScenario([])).toBeUndefined();
    });
});
