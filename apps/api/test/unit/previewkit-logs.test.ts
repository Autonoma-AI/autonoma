import type { BuildLogEntry } from "@autonoma/logger/build-log-event";
import { describe, expect, it } from "vitest";
import type { PreviewkitEnvironmentsService } from "../../src/previewkit/previewkit-environments.service";
import { PreviewkitLogsService } from "../../src/previewkit/previewkit-logs.service";

/** Minimal environments-service stand-in: resolves (or fails to resolve) a stream target. */
function fakeEnvironments(namespace: string | undefined): PreviewkitEnvironmentsService {
    const resolveStreamTarget = async () => (namespace != null ? { namespace, status: "ready" } : undefined);
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
