import { beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_SECRET = "test-secret-for-hmac-signing";

// Set env before importing the module
process.env.BETTER_AUTH_SECRET = MOCK_SECRET;

import { createInstallState, verifyInstallState } from "../../../src/github/github-state";

describe("github-state", () => {
    beforeEach(() => {
        process.env.BETTER_AUTH_SECRET = MOCK_SECRET;
    });

    describe("createInstallState", () => {
        it("returns a payload.signature string", () => {
            const state = createInstallState("org-123");
            expect(state).toContain(".");
            const parts = state.split(".");
            expect(parts).toHaveLength(2);
        });

        it("encodes organization ID in the payload", () => {
            const state = createInstallState("org-456");
            const payload = state.split(".")[0]!;
            const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
            expect(decoded.organizationId).toBe("org-456");
        });

        it("includes return path when provided", () => {
            const state = createInstallState("org-123", "/settings/github");
            const payload = state.split(".")[0]!;
            const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
            expect(decoded.returnPath).toBe("/settings/github");
        });

        it("sets expiry in the future", () => {
            const before = Date.now();
            const state = createInstallState("org-123");
            const payload = state.split(".")[0]!;
            const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
            expect(decoded.exp).toBeGreaterThan(before);
            expect(decoded.exp).toBeLessThanOrEqual(before + 15 * 60 * 1000 + 100);
        });
    });

    describe("verifyInstallState", () => {
        it("round-trips a valid state", () => {
            const state = createInstallState("org-789", "/some/path");
            const result = verifyInstallState(state);
            expect(result).toEqual({ organizationId: "org-789", returnPath: "/some/path" });
        });

        it("returns organizationId without return path", () => {
            const state = createInstallState("org-abc");
            const result = verifyInstallState(state);
            expect(result).toEqual({ organizationId: "org-abc", returnPath: undefined });
        });

        it("rejects tampered payload", () => {
            const state = createInstallState("org-123");
            const [, sig] = state.split(".");
            const tamperedPayload = Buffer.from(JSON.stringify({ organizationId: "hacker", exp: Date.now() + 999999 })).toString("base64url");
            const result = verifyInstallState(`${tamperedPayload}.${sig}`);
            expect(result).toBeUndefined();
        });

        it("rejects tampered signature", () => {
            const state = createInstallState("org-123");
            const [payload] = state.split(".");
            const result = verifyInstallState(`${payload}.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`);
            expect(result).toBeUndefined();
        });

        it("rejects state without a dot separator", () => {
            const result = verifyInstallState("nodothere");
            expect(result).toBeUndefined();
        });

        it("rejects expired state", () => {
            vi.useFakeTimers();
            const state = createInstallState("org-123");

            // Advance past the 15-minute TTL
            vi.advanceTimersByTime(16 * 60 * 1000);

            const result = verifyInstallState(state);
            expect(result).toBeUndefined();

            vi.useRealTimers();
        });

        it("accepts state just before expiry", () => {
            vi.useFakeTimers();
            const state = createInstallState("org-123");

            // Advance to just before the 15-minute TTL
            vi.advanceTimersByTime(14 * 60 * 1000);

            const result = verifyInstallState(state);
            expect(result).toEqual({ organizationId: "org-123", returnPath: undefined });

            vi.useRealTimers();
        });
    });

    describe("error handling", () => {
        it("throws when BETTER_AUTH_SECRET is not set", () => {
            delete process.env.BETTER_AUTH_SECRET;
            expect(() => createInstallState("org-123")).toThrow("BETTER_AUTH_SECRET is not set");
        });
    });
});
