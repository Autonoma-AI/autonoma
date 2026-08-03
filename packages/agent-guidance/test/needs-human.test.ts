import { describe, expect, it } from "vitest";
import { needsHuman } from "../src/needs-human";

/**
 * The point of this shape is that an agent can act on it without knowing anything about the
 * specific step: it is not an error, there is a link to hand over, and there is a named tool
 * to poll. So those are what the tests hold onto.
 */
describe("needsHuman", () => {
    const outcome = needsHuman({
        action: "install_github_app",
        reason: "Autonoma's GitHub App is not installed on this organization.",
        url: "https://github.com/apps/autonoma/installations/new?state=abc",
        pollWith: "get_github_connection",
        expiresAt: new Date("2026-08-03T21:15:00.000Z"),
    });

    it("is a distinct status, not an error, so an agent does not retry or give up", () => {
        expect(outcome.status).toBe("needs_human");
    });

    it("names the tool to poll, so waiting does not need a documented convention", () => {
        expect(outcome.pollWith).toBe("get_github_connection");
    });

    it("serializes the deadline, since JSON has no date type", () => {
        expect(outcome.expiresAt).toBe("2026-08-03T21:15:00.000Z");
        expect(JSON.parse(JSON.stringify(outcome)).expiresAt).toBe("2026-08-03T21:15:00.000Z");
    });

    it("omits the deadline when the step has none, rather than inventing one", () => {
        const forever = needsHuman({
            action: "verify_email",
            reason: "The invite has to be accepted from the mailbox it was sent to.",
            url: "https://autonoma.app/settings",
            pollWith: "get_session_status",
        });

        expect(forever.expiresAt).toBeUndefined();
    });
});
