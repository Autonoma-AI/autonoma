import type { BuildLogEntry } from "@autonoma/logger/build-log-event";
import { describe, expect, it } from "vitest";
import type { PreviewkitEnvironmentsService } from "../../src/previewkit/previewkit-environments.service";
import { PreviewkitLogsService } from "../../src/previewkit/previewkit-logs.service";

/** Minimal environments-service stand-in: resolves (or fails to resolve) a stream target. */
function fakeEnvironments(namespace: string | undefined, serviceNames: string[] = ["web", "db"]) {
    const resolveStreamTarget = async () =>
        namespace != null ? { namespace, status: "ready", serviceNames } : undefined;
    // The service only calls resolveStreamTarget; the rest of the surface is unused here.
    return { resolveStreamTarget } as unknown as PreviewkitEnvironmentsService;
}

/** A fake tail store that records how it was called and returns canned entries. */
function fakeStore(entries: BuildLogEntry[]) {
    const calls: { environmentId: string; limit: number; options: unknown }[] = [];
    return {
        calls,
        readLastN: async (
            environmentId: string,
            limit: number,
            options: { app?: string; filter?: string; from?: "head" | "tail" } = {},
        ) => {
            calls.push({ environmentId, limit, options });
            return entries;
        },
    };
}

function entry(id: string, message: string): BuildLogEntry {
    return { id, event: { kind: "log", app: "web", stream: "stdout", message } };
}

describe("PreviewkitLogsService", () => {
    it("flattens Loki entries into agent-friendly log lines for the requested source", async () => {
        const store = fakeStore([entry("100", "starting"), entry("200", "listening")]);
        const service = new PreviewkitLogsService(fakeEnvironments("preview-acme-web-pr-7"), store, undefined);

        const result = await service.tail({
            repoFullName: "acme/web",
            prNumber: 7,
            source: "build",
            callerOrgId: "org-1",
            limit: 50,
        });

        expect(result).toEqual({
            available: true,
            source: "build",
            truncated: false,
            services: ["web"],
            lines: [
                { timestampNs: "100", message: "starting", app: "web", stream: "stdout", kind: "log" },
                { timestampNs: "200", message: "listening", app: "web", stream: "stdout", kind: "log" },
            ],
        });
        // The namespace resolved from (repo, pr) is what gets tailed, with the passed limit.
        expect(store.calls).toEqual([
            {
                environmentId: "preview-acme-web-pr-7",
                limit: 50,
                options: { app: undefined, filter: undefined, from: undefined },
            },
        ]);
    });

    it("keeps full line content but drops whole lines from the far end past the byte budget", async () => {
        // Two ~700KB lines: together they exceed the 1MB total budget. Tailing keeps the
        // newest whole line and drops the oldest, and never cuts the kept line's content.
        const big = "y".repeat(700_000);
        const store = fakeStore([entry("100", `old ${big}`), entry("200", `new ${big}`)]);
        const service = new PreviewkitLogsService(fakeEnvironments("ns"), store, undefined);

        const result = await service.tail({
            repoFullName: "acme/web",
            prNumber: 7,
            source: "build",
            callerOrgId: "org-1",
        });

        expect(result?.truncated).toBe(true);
        expect(result?.lines).toHaveLength(1);
        // The newest line is kept, in full (not truncated).
        expect(result?.lines[0]?.message).toBe(`new ${big}`);
    });

    it("honours a caller's byte budget and says how much it dropped", async () => {
        // A "line" here is a whole buildkit chunk, so a handful of them already outrun a
        // budget sized for a model's context - the count limit alone would not catch it.
        const chunk = "z".repeat(5_000);
        const store = fakeStore([entry("100", chunk), entry("200", chunk), entry("300", chunk)]);
        const service = new PreviewkitLogsService(fakeEnvironments("ns"), store, undefined);

        const result = await service.tail({
            repoFullName: "acme/web",
            prNumber: 7,
            source: "build",
            callerOrgId: "org-1",
            maxBytes: 12_000,
        });

        expect(result?.lines).toHaveLength(2);
        expect(result?.truncated).toBe(true);
        // Truncation is stated, not inferred from a short list that reads as the whole window.
        expect(result?.dropped).toEqual({ lines: 1, from: "oldest", budgetBytes: 12_000 });
        // Tailing keeps the newest.
        expect(result?.lines[0]?.timestampNs).toBe("200");
    });

    it("drops the newest when reading from the head, and says which end went", async () => {
        const chunk = "z".repeat(5_000);
        const store = fakeStore([entry("100", chunk), entry("200", chunk), entry("300", chunk)]);
        const service = new PreviewkitLogsService(fakeEnvironments("ns"), store, undefined);

        const result = await service.tail({
            repoFullName: "acme/web",
            prNumber: 7,
            source: "build",
            callerOrgId: "org-1",
            from: "head",
            maxBytes: 12_000,
        });

        expect(result?.dropped).toEqual({ lines: 1, from: "newest", budgetBytes: 12_000 });
        expect(result?.lines[0]?.timestampNs).toBe("100");
    });

    it("says nothing was truncated when everything fits", async () => {
        const store = fakeStore([entry("100", "starting")]);
        const service = new PreviewkitLogsService(fakeEnvironments("ns"), store, undefined);

        const result = await service.tail({
            repoFullName: "acme/web",
            prNumber: 7,
            source: "build",
            callerOrgId: "org-1",
            maxBytes: 12_000,
        });

        expect(result?.truncated).toBe(false);
        expect(result?.dropped).toBeUndefined();
    });

    it("tells a service name that does not exist apart from a service that was quiet", async () => {
        const store = fakeStore([]);
        const service = new PreviewkitLogsService(fakeEnvironments("ns", ["web", "db"]), store, store);

        const typo = await service.tail({
            repoFullName: "acme/web",
            prNumber: 7,
            source: "app",
            callerOrgId: "org-1",
            app: "wbe",
        });

        expect(typo?.available).toBe(false);
        expect(typo?.unknownService).toEqual({ requested: "wbe", known: ["web", "db"] });
        // A wrong name is not a query - nothing was read.
        expect(store.calls).toHaveLength(0);

        const quiet = await service.tail({
            repoFullName: "acme/web",
            prNumber: 7,
            source: "app",
            callerOrgId: "org-1",
            app: "db",
        });

        // A real service with no output in the window still reads as an available, empty result.
        expect(quiet?.available).toBe(true);
        expect(quiet?.unknownService).toBeUndefined();
        expect(quiet?.lines).toEqual([]);
    });

    it("reports not-configured (never throws) when the source store is absent", async () => {
        const service = new PreviewkitLogsService(fakeEnvironments("ns"), undefined, undefined);

        const result = await service.tail({ repoFullName: "acme/web", prNumber: 7, source: "app", callerOrgId: "o" });

        expect(result).toEqual({
            available: false,
            source: "app",
            reason: "Log streaming is not configured.",
            lines: [],
            services: [],
        });
    });

    it("returns undefined when no environment resolves (maps to not-found in the tool)", async () => {
        const store = fakeStore([]);
        const service = new PreviewkitLogsService(fakeEnvironments(undefined), store, store);

        const result = await service.tail({
            repoFullName: "acme/web",
            prNumber: 999,
            source: "build",
            callerOrgId: "o",
        });

        expect(result).toBeUndefined();
        expect(store.calls).toHaveLength(0);
    });
});
