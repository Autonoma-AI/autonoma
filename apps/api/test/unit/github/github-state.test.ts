import { beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_SECRET = "test-secret-for-hmac-signing";

// Set env before importing the module - it reads the secret when signing.
process.env.BETTER_AUTH_SECRET = MOCK_SECRET;

import { SignJWT } from "jose";
import { createInstallState, verifyInstallState } from "../../../src/github/github-state";

const key = () => new TextEncoder().encode(MOCK_SECRET);

describe("github-state", () => {
    beforeEach(() => {
        process.env.BETTER_AUTH_SECRET = MOCK_SECRET;
    });

    it("round-trips an organization and return path", async () => {
        const state = await createInstallState("org-789", "/some/path");

        await expect(verifyInstallState(state)).resolves.toEqual({
            organizationId: "org-789",
            returnPath: "/some/path",
        });
    });

    it("round-trips without a return path", async () => {
        const state = await createInstallState("org-abc");

        await expect(verifyInstallState(state)).resolves.toEqual({ organizationId: "org-abc" });
    });

    it("rejects a token signed with a different secret", async () => {
        const forged = await new SignJWT({ organizationId: "attacker" })
            .setProtectedHeader({ alg: "HS256" })
            .setAudience("autonoma:github-install-state")
            .setExpirationTime("15m")
            .sign(new TextEncoder().encode("not-the-real-secret"));

        await expect(verifyInstallState(forged)).resolves.toBeUndefined();
    });

    /**
     * Domain separation. Anything else we ever sign with this secret must not verify as install
     * state, which is what the audience claim buys - and `jose` checks it as part of verification
     * rather than leaving it to a caller to remember.
     */
    it("rejects a validly signed token minted for another purpose", async () => {
        const otherPurpose = await new SignJWT({ organizationId: "org-1" })
            .setProtectedHeader({ alg: "HS256" })
            .setAudience("autonoma:something-else")
            .setExpirationTime("15m")
            .sign(key());

        await expect(verifyInstallState(otherPurpose)).resolves.toBeUndefined();
    });

    /**
     * `alg: none` is the classic JWT footgun: a verifier that trusts the token's own header accepts
     * an unsigned token. Pinning `algorithms` on verify is what rules it out.
     */
    it("rejects an unsigned token claiming alg none", async () => {
        const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
        const body = Buffer.from(
            JSON.stringify({
                organizationId: "attacker",
                aud: "autonoma:github-install-state",
                exp: Math.floor(Date.now() / 1000) + 600,
            }),
        ).toString("base64url");

        await expect(verifyInstallState(`${header}.${body}.`)).resolves.toBeUndefined();
    });

    it("rejects a malformed token", async () => {
        await expect(verifyInstallState("nodothere")).resolves.toBeUndefined();
    });

    it("rejects an expired token", async () => {
        vi.useFakeTimers();
        const state = await createInstallState("org-123");

        vi.advanceTimersByTime(16 * 60 * 1000);
        await expect(verifyInstallState(state)).resolves.toBeUndefined();

        vi.useRealTimers();
    });

    it("accepts a token just before expiry", async () => {
        vi.useFakeTimers();
        const state = await createInstallState("org-123");

        vi.advanceTimersByTime(14 * 60 * 1000);
        await expect(verifyInstallState(state)).resolves.toEqual({ organizationId: "org-123" });

        vi.useRealTimers();
    });

    it("throws when BETTER_AUTH_SECRET is not set", async () => {
        delete process.env.BETTER_AUTH_SECRET;
        await expect(createInstallState("org-123")).rejects.toThrow("BETTER_AUTH_SECRET is not set");
    });
});
