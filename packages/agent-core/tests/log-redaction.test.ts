import { describe, expect, it } from "vitest";
import { redactForLog } from "../src/agent/log-redaction";

const OVERSIZED = "x".repeat(5_000);

describe("redactForLog", () => {
    it("leaves a value a log reader can still use untouched", () => {
        const value = { stepOrder: 3, ok: true, note: "short", tags: ["a", "b"], missing: undefined };

        expect(redactForLog(value)).toEqual(value);
    });

    it("replaces an oversized string with its length, wherever it is nested", () => {
        const value = { frames: [{ timing: "before", base64: OVERSIZED }] };

        expect(redactForLog(value)).toEqual({ frames: [{ timing: "before", base64: "[5000 chars elided]" }] });
    });

    it("elides raw bytes by size", () => {
        expect(redactForLog({ buffer: Buffer.alloc(2_048) })).toEqual({ buffer: "[2048 bytes elided]" });
    });

    it("passes through a value that carries its own serialization", () => {
        const error = new Error("boom");

        expect(redactForLog({ error })).toEqual({ error });
    });

    it("stops walking a self-referential value instead of spinning", () => {
        const cyclic: Record<string, unknown> = { name: "loop" };
        cyclic.self = cyclic;

        expect(() => JSON.stringify(redactForLog(cyclic))).not.toThrow();
    });
});
