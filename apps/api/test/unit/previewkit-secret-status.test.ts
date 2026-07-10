import type { SecretSummary } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { computeSecretStatus } from "../../src/previewkit/previewkit-secret-status.service";

/** A masked present-secret summary; the value/length are opaque to these tests. */
function present(key: string, maskedLength = 8): SecretSummary {
    return { key, maskedLength, updatedAt: new Date("2026-07-08T00:00:00.000Z") };
}

describe("computeSecretStatus", () => {
    it("flags a declared build secret with no registered value as missing", () => {
        const status = computeSecretStatus(["DATABASE_URL", "API_KEY"], [present("DATABASE_URL")]);

        expect(status).toEqual([
            { key: "API_KEY", present: false, maskedLength: undefined, requiredAtBuild: true },
            { key: "DATABASE_URL", present: true, maskedLength: 8, requiredAtBuild: true },
        ]);
    });

    it("includes present runtime secrets that are not declared as build secrets", () => {
        const status = computeSecretStatus(["API_KEY"], [present("API_KEY", 32), present("SESSION_SECRET", 16)]);

        // Union of declared + present, sorted; the runtime-only key is present but not build-required.
        expect(status).toEqual([
            { key: "API_KEY", present: true, maskedLength: 32, requiredAtBuild: true },
            { key: "SESSION_SECRET", present: true, maskedLength: 16, requiredAtBuild: false },
        ]);
    });

    it("never exposes a value - only presence, masked length, fingerprint, and requirement", () => {
        const [entry] = computeSecretStatus(["TOKEN"], [present("TOKEN", 40)]);
        expect(Object.keys(entry ?? {})).toEqual(["key", "present", "maskedLength", "fingerprint", "requiredAtBuild"]);
    });

    it("carries the fingerprint of a present secret so a value can be compared without exposure", () => {
        const summary: SecretSummary = {
            key: "TOKEN",
            maskedLength: 40,
            updatedAt: new Date(),
            fingerprint: "abc123def456",
        };
        const [entry] = computeSecretStatus([], [summary]);
        expect(entry?.fingerprint).toBe("abc123def456");
    });

    it("returns an empty list when nothing is declared or present", () => {
        expect(computeSecretStatus([], [])).toEqual([]);
    });
});
