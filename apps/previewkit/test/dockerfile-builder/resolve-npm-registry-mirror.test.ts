import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNpmRegistryMirror } from "../../src/dockerfile-builder/resolve-npm-registry-mirror";

const MIRROR = "http://verdaccio.buildkit.svc.cluster.local:4873/";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("resolveNpmRegistryMirror", () => {
    it("keeps the mirror when it answers healthily", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("pong", { status: 200 })));
        await expect(resolveNpmRegistryMirror(MIRROR)).resolves.toBe(MIRROR);
    });

    it("probes the registry's liveness endpoint", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response("pong", { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        await resolveNpmRegistryMirror(MIRROR);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(`${MIRROR}-/ping`);
    });

    // The whole point: an unhealthy mirror must not fail the build. Falling back
    // to "" is what both injection paths already read as "use the public registry".
    it("falls back to the public registry when the mirror errors", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
        await expect(resolveNpmRegistryMirror(MIRROR)).resolves.toBe("");
    });

    it("falls back to the public registry when the mirror is unreachable", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
        await expect(resolveNpmRegistryMirror(MIRROR)).resolves.toBe("");
    });

    // The resolver is awaited during service construction, before the runner's
    // own try, so an escaping throw would crash the build at startup instead of
    // degrading it. A missing scheme is the easy typo that makes `new URL` throw.
    it("falls back to the public registry when the mirror is a malformed URL", async () => {
        vi.stubGlobal("fetch", vi.fn());
        await expect(resolveNpmRegistryMirror("verdaccio.buildkit.svc.cluster.local:4873")).resolves.toBe("");
    });

    it("stays disabled when no mirror is configured, without probing", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await expect(resolveNpmRegistryMirror("")).resolves.toBe("");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
