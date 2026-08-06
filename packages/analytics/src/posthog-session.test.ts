import { describe, expect, it } from "vitest";
import { getPostHogSessionId, withPostHogSession } from "./posthog-session";

/** Yields to the event loop, so a scope has to survive a real async boundary rather than a synchronous call. */
async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("withPostHogSession", () => {
    it("binds the session for everything the request goes on to do", async () => {
        const seen = await withPostHogSession("sess-1", async () => {
            await tick();
            return getPostHogSessionId();
        });

        expect(seen).toBe("sess-1");
    });

    it("leaves the scope unbound when the request carried no session", async () => {
        // The normal case for a job, a Vercel machine-to-machine callback or the
        // CLI - callers wrap unconditionally and must not get a bogus session.
        const seen = await withPostHogSession(undefined, async () => getPostHogSessionId());
        expect(seen).toBeUndefined();
    });

    it("treats an empty header as no session rather than binding an empty string", async () => {
        // `posthog.get_session_id()` answers "" before init, and the browser could
        // send that through if the header guard ever regressed.
        const seen = await withPostHogSession("", async () => getPostHogSessionId());
        expect(seen).toBeUndefined();
    });

    it("keeps concurrent requests from seeing each other's session", async () => {
        // The reason this is an AsyncLocalStorage and not a module variable: the
        // API serves requests concurrently, and a leak here would attribute one
        // customer's server-side events to another customer's session recording.
        const [first, second, unbound] = await Promise.all([
            withPostHogSession("sess-a", async () => {
                await tick();
                return getPostHogSessionId();
            }),
            withPostHogSession("sess-b", async () => getPostHogSessionId()),
            (async () => {
                await tick();
                return getPostHogSessionId();
            })(),
        ]);

        expect(first).toBe("sess-a");
        expect(second).toBe("sess-b");
        expect(unbound).toBeUndefined();
    });

    it("does not leak the session past the request that carried it", async () => {
        await withPostHogSession("sess-1", async () => tick());
        expect(getPostHogSessionId()).toBeUndefined();
    });

    it("returns the callback's own value untouched", async () => {
        await expect(withPostHogSession("sess-1", async () => "response-body")).resolves.toBe("response-body");
    });
});
