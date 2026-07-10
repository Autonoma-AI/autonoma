import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LokiLogStore } from "../../src/loki-log-store";

/**
 * Exercises the LokiLogStore against a real Grafana Loki (Testcontainers) -
 * the push -> readBatch round-trip, ascending ordering across label streams,
 * cursor resume, source/namespace isolation, and label-to-event mapping that
 * types alone can't prove. Uses the image's baked-in local config (filesystem
 * storage, auth disabled), the same API surface the EC2 instance serves. Run
 * with `pnpm test:integration`; the default `pnpm test` excludes
 * `test/integration/**`, so it needs no Docker.
 */
describe("LokiLogStore (integration)", () => {
    let container: StartedTestContainer;
    let baseUrl: string;
    let appStore: LokiLogStore;

    beforeAll(async () => {
        container = await new GenericContainer("grafana/loki:3.4.1")
            .withExposedPorts(3100)
            // /ready returns 503 while the ingester warms up, then 200.
            .withWaitStrategy(Wait.forHttp("/ready", 3100).withStartupTimeout(120_000))
            .start();
        baseUrl = `http://${container.getHost()}:${container.getMappedPort(3100)}`;
        appStore = new LokiLogStore(baseUrl, "app");
    }, 130_000);

    afterAll(async () => {
        await container?.stop();
    });

    /** Monotonic nanosecond timestamps so per-test pushes are strictly ordered. */
    let tick = 0n;
    function nextNs(): string {
        tick += 1n;
        return (BigInt(Date.now()) * 1_000_000n + tick).toString();
    }

    async function push(labels: Record<string, string>, lines: [string, string][]): Promise<void> {
        const response = await fetch(`${baseUrl}/loki/api/v1/push`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ streams: [{ stream: labels, values: lines }] }),
        });
        if (!response.ok) {
            throw new Error(`Loki push failed: ${response.status} ${await response.text()}`);
        }
    }

    /** Ingestion is near-instant but not synchronous; poll briefly to avoid flakes. */
    async function readUntil(
        store: LokiLogStore,
        namespace: string,
        cursor: string,
        minEntries: number,
        app?: string,
        filter?: string,
    ): Promise<Awaited<ReturnType<LokiLogStore["readBatch"]>>> {
        const deadline = Date.now() + 10_000;
        let batch = await store.readBatch(namespace, cursor, app, filter);
        while (batch.length < minEntries && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            batch = await store.readBatch(namespace, cursor, app, filter);
        }
        return batch;
    }

    it("round-trips app log lines in ascending order across label streams", async () => {
        const namespace = "preview-acme-api-pr-1";

        // Two label streams (stdout + stderr) interleaved in time - readBatch
        // must merge them into one ascending timeline.
        const first = nextNs();
        const second = nextNs();
        const third = nextNs();
        await push({ namespace, source: "app", app: "api", stream: "stdout", kind: "log" }, [
            [first, "listening on :3000"],
            [third, "GET /health 200"],
        ]);
        await push({ namespace, source: "app", app: "api", stream: "stderr", kind: "log" }, [
            [second, "deprecation warning"],
        ]);

        const entries = await readUntil(appStore, namespace, "0", 3);

        expect(entries.map((entry) => entry.event)).toEqual([
            { kind: "log", app: "api", stream: "stdout", message: "listening on :3000" },
            { kind: "log", app: "api", stream: "stderr", message: "deprecation warning" },
            { kind: "log", app: "api", stream: "stdout", message: "GET /health 200" },
        ]);
        expect(entries.map((entry) => entry.id)).toEqual([first, second, third]);
    });

    it("resumes after a cursor, returning only newer entries", async () => {
        const namespace = "preview-acme-api-pr-2";

        await push({ namespace, source: "app", app: "web", stream: "stdout", kind: "log" }, [[nextNs(), "first"]]);
        const firstBatch = await readUntil(appStore, namespace, "0", 1);
        expect(firstBatch).toHaveLength(1);

        const firstEntry = firstBatch[0];
        if (firstEntry == null) throw new Error("expected the first entry to be present");

        // Nothing newer yet.
        expect(await appStore.readBatch(namespace, firstEntry.id)).toEqual([]);

        await push({ namespace, source: "app", app: "web", stream: "stdout", kind: "log" }, [[nextNs(), "second"]]);
        const resumed = await readUntil(appStore, namespace, firstEntry.id, 1);

        expect(resumed.map((entry) => entry.event.message)).toEqual(["second"]);
    });

    it("isolates sources: an app store never sees build lines", async () => {
        const namespace = "preview-acme-api-pr-3";
        const buildStore = new LokiLogStore(baseUrl, "build");

        await push({ namespace, source: "build", app: "api", kind: "log" }, [[nextNs(), "step 1/3"]]);
        await push({ namespace, source: "app", app: "api", stream: "stdout", kind: "log" }, [[nextNs(), "booted"]]);

        const buildEntries = await readUntil(buildStore, namespace, "0", 1);
        const appEntries = await readUntil(appStore, namespace, "0", 1);

        expect(buildEntries.map((entry) => entry.event.message)).toEqual(["step 1/3"]);
        expect(appEntries.map((entry) => entry.event.message)).toEqual(["booted"]);
    });

    it("isolates namespaces", async () => {
        await push({ namespace: "preview-a-pr-1", source: "app", stream: "stdout", kind: "log" }, [
            [nextNs(), "from a"],
        ]);
        await push({ namespace: "preview-b-pr-1", source: "app", stream: "stdout", kind: "log" }, [
            [nextNs(), "from b"],
        ]);

        const fromA = await readUntil(appStore, "preview-a-pr-1", "0", 1);

        expect(fromA.map((entry) => entry.event.message)).toEqual(["from a"]);
    });

    it("defaults kind to 'log' when the label is absent", async () => {
        const namespace = "preview-acme-api-pr-4";

        await push({ namespace, source: "app", app: "api", stream: "stdout" }, [[nextNs(), "no kind label"]]);

        const entries = await readUntil(appStore, namespace, "0", 1);
        expect(entries.map((entry) => entry.event.kind)).toEqual(["log"]);
    });

    it("tails the newest lines for an app store but replays from the start for a build store", async () => {
        const namespace = "preview-acme-api-pr-5";
        const buildStore = new LokiLogStore(baseUrl, "build");

        // 600 lines per source - one full READ_LIMIT (500) plus 100 - pushed as
        // one batch per source so visibility is atomic per label stream.
        const total = 600;
        const appValues: [string, string][] = [];
        const buildValues: [string, string][] = [];
        for (let i = 0; i < total; i++) appValues.push([nextNs(), `app line ${i}`]);
        for (let i = 0; i < total; i++) buildValues.push([nextNs(), `build line ${i}`]);
        await push({ namespace, source: "app", app: "api", stream: "stdout", kind: "log" }, appValues);
        await push({ namespace, source: "build", app: "api", kind: "log" }, buildValues);

        const appBatch = await readUntil(appStore, namespace, "0", 500);
        const buildBatch = await readUntil(buildStore, namespace, "0", 500);

        // App: tail semantics - the newest 500 of 600, so it starts at line 100.
        expect(appBatch).toHaveLength(500);
        expect(appBatch[0]?.event.message).toBe("app line 100");
        expect(appBatch[499]?.event.message).toBe("app line 599");
        // Build: replay semantics - the first batch is lines 0-499; the relay's
        // next poll resumes from the cursor to fetch the rest.
        expect(buildBatch).toHaveLength(500);
        expect(buildBatch[0]?.event.message).toBe("build line 0");
        expect(buildBatch[499]?.event.message).toBe("build line 499");
    });

    it("readLastN returns the newest N lines in ascending order and respects the limit", async () => {
        const namespace = "preview-acme-api-pr-tail";
        const buildStore = new LokiLogStore(baseUrl, "build");

        const values: [string, string][] = [];
        for (let i = 0; i < 50; i++) values.push([nextNs(), `build line ${i}`]);
        await push({ namespace, source: "build", app: "api", kind: "log" }, values);

        // Poll via readLastN until all 50 have landed, then assert the tail shape.
        const deadline = Date.now() + 10_000;
        let tail = await buildStore.readLastN(namespace, 10);
        while (tail.length < 10 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            tail = await buildStore.readLastN(namespace, 10);
        }

        // The newest 10 of 50, returned oldest-to-newest.
        expect(tail).toHaveLength(10);
        expect(tail[0]?.event.message).toBe("build line 40");
        expect(tail[9]?.event.message).toBe("build line 49");
    });

    it("readLastN narrows to one app and applies a case-insensitive filter", async () => {
        const namespace = "preview-acme-api-pr-tail2";
        const appStoreLocal = new LokiLogStore(baseUrl, "app");

        await push({ namespace, source: "app", app: "web", stream: "stdout", kind: "log" }, [
            [nextNs(), "WEB booting"],
            [nextNs(), "web ERROR: boom"],
        ]);
        await push({ namespace, source: "app", app: "api", stream: "stdout", kind: "log" }, [[nextNs(), "api ok"]]);

        const deadline = Date.now() + 10_000;
        let filtered = await appStoreLocal.readLastN(namespace, 20, { app: "web", filter: "error" });
        while (filtered.length < 1 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            filtered = await appStoreLocal.readLastN(namespace, 20, { app: "web", filter: "error" });
        }

        expect(filtered.map((entry) => entry.event.message)).toEqual(["web ERROR: boom"]);
    });

    it("readLastN from 'head' returns the oldest N lines and never truncates line content", async () => {
        const namespace = "preview-acme-api-pr-head";
        const buildStore = new LokiLogStore(baseUrl, "build");

        const values: [string, string][] = [];
        // A start marker so "head" replays from the build's beginning, then 30 lines,
        // the first of which is a huge single-line blob that must come back WHOLE.
        values.push([nextNs(), "start"]);
        const huge = "x".repeat(9000);
        values.push([nextNs(), `build line 0 ${huge}`]);
        for (let i = 1; i < 30; i++) values.push([nextNs(), `build line ${i}`]);
        await push({ namespace, source: "build", app: "api", kind: "start" }, [values[0]!]);
        await push({ namespace, source: "build", app: "api", kind: "log" }, values.slice(1));

        const deadline = Date.now() + 10_000;
        let head = await buildStore.readLastN(namespace, 5, { from: "head" });
        while (head.length < 5 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            head = await buildStore.readLastN(namespace, 5, { from: "head" });
        }

        // The oldest 5 lines from the build's start (start marker excluded from output).
        expect(head).toHaveLength(5);
        expect(head[4]?.event.message).toBe("build line 4");
        // The huge first line is returned in full - no truncation at the store layer.
        expect(head[0]?.event.message).toBe(`build line 0 ${huge}`);
    });

    it("replays a build only from the latest start marker, overwriting prior attempts", async () => {
        const namespace = "preview-acme-api-pr-10";
        const buildStore = new LokiLogStore(baseUrl, "build");

        // Attempt 1: a start marker then one log line.
        await push({ namespace, source: "build", kind: "start" }, [[nextNs(), ""]]);
        await push({ namespace, source: "build", app: "api", kind: "log" }, [[nextNs(), "attempt 1\n"]]);
        // Ensure attempt 1 is ingested before attempt 2's marker is written.
        await readUntil(buildStore, namespace, "0", 1);

        // Attempt 2: a newer marker resets the replay floor past attempt 1.
        await push({ namespace, source: "build", kind: "start" }, [[nextNs(), ""]]);
        await push({ namespace, source: "build", app: "api", kind: "log" }, [[nextNs(), "attempt 2\n"]]);

        // A fresh viewer sees only attempt 2 - the marker excludes attempt 1's
        // line, and the marker lines themselves never surface.
        const deadline = Date.now() + 10_000;
        let entries = await buildStore.readBatch(namespace, "0");
        while ((entries.length !== 1 || entries[0]?.event.message !== "attempt 2\n") && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            entries = await buildStore.readBatch(namespace, "0");
        }
        expect(entries.map((entry) => entry.event.message)).toEqual(["attempt 2\n"]);
    });

    it("replays an app stream only from the latest deployment marker, superseding prior deployments", async () => {
        const namespace = "preview-acme-api-pr-12";

        // Deployment 1: a start marker then one runtime line.
        await push({ namespace, source: "app", kind: "start" }, [[nextNs(), ""]]);
        await push({ namespace, source: "app", app: "api", stream: "stdout", kind: "log" }, [
            [nextNs(), "deploy 1 line"],
        ]);
        // Ensure deployment 1 is ingested before deployment 2's marker is written.
        await readUntil(appStore, namespace, "0", 1);

        // Deployment 2: a newer marker resets the replay floor past deployment 1.
        await push({ namespace, source: "app", kind: "start" }, [[nextNs(), ""]]);
        await push({ namespace, source: "app", app: "api", stream: "stdout", kind: "log" }, [
            [nextNs(), "deploy 2 line"],
        ]);

        // A fresh viewer sees only deployment 2 - the marker excludes deployment
        // 1's line, and the marker lines themselves never surface.
        const deadline = Date.now() + 10_000;
        let entries = await appStore.readBatch(namespace, "0");
        while ((entries.length !== 1 || entries[0]?.event.message !== "deploy 2 line") && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            entries = await appStore.readBatch(namespace, "0");
        }
        expect(entries.map((entry) => entry.event.message)).toEqual(["deploy 2 line"]);
    });

    it("replays the full window for a build with no start marker (back-compat)", async () => {
        const namespace = "preview-acme-api-pr-11";
        const buildStore = new LokiLogStore(baseUrl, "build");

        await push({ namespace, source: "build", app: "api", kind: "log" }, [[nextNs(), "unmarked line\n"]]);

        const entries = await readUntil(buildStore, namespace, "0", 1);
        expect(entries.map((entry) => entry.event.message)).toEqual(["unmarked line\n"]);
    });

    it("treats a foreign-format cursor (e.g. a Redis Stream entry id) as a fresh viewer", async () => {
        const namespace = "preview-acme-api-pr-6";

        await push({ namespace, source: "app", stream: "stdout", kind: "log" }, [[nextNs(), "hello"]]);

        const entries = await readUntil(appStore, namespace, "1718000000000-0", 1);
        expect(entries.map((entry) => entry.event.message)).toEqual(["hello"]);
    });

    it("returns an empty batch for a namespace that was never written", async () => {
        expect(await appStore.readBatch("preview-never-written-pr-9", "0")).toEqual([]);
    });

    it("rejects environment ids outside the namespace charset", async () => {
        await expect(appStore.readBatch('preview-"}{evil', "0")).rejects.toThrow(/Invalid environment id/);
    });

    it("filters to a single app when an app name is given", async () => {
        const namespace = "preview-acme-api-pr-7";

        await push({ namespace, source: "app", app: "web", stream: "stdout", kind: "log" }, [[nextNs(), "from web"]]);
        await push({ namespace, source: "app", app: "api", stream: "stdout", kind: "log" }, [[nextNs(), "from api"]]);

        // Unfiltered: both apps' lines.
        const all = await readUntil(appStore, namespace, "0", 2);
        expect(all.map((entry) => entry.event.message).sort()).toEqual(["from api", "from web"]);

        // Filtered to "api": only that app's line.
        const apiOnly = await readUntil(appStore, namespace, "0", 1, "api");
        expect(apiOnly.map((entry) => entry.event.message)).toEqual(["from api"]);
        expect(apiOnly.every((entry) => entry.event.app === "api")).toBe(true);
    });

    it("rejects app names outside the allowed charset", async () => {
        await expect(appStore.readBatch("preview-acme-api-pr-8", "0", 'api"}{evil')).rejects.toThrow(
            /Invalid app name/,
        );
    });

    it("filters lines to a case-insensitive substring when a filter is given", async () => {
        const namespace = "preview-acme-api-pr-13";

        await push({ namespace, source: "app", app: "api", stream: "stdout", kind: "log" }, [
            [nextNs(), "GET /health 200"],
            [nextNs(), "GET /users 500 Internal Server ERROR"],
            [nextNs(), "GET /users 200"],
        ]);

        // Case-insensitive: "error" matches the "ERROR" line only.
        const errors = await readUntil(appStore, namespace, "0", 1, undefined, "error");
        expect(errors.map((entry) => entry.event.message)).toEqual(["GET /users 500 Internal Server ERROR"]);
    });

    it("treats the filter as a literal, not a regex (metacharacters match themselves)", async () => {
        const namespace = "preview-acme-api-pr-14";

        await push({ namespace, source: "app", app: "api", stream: "stdout", kind: "log" }, [
            [nextNs(), "price is 9.99 today"],
            [nextNs(), "price is 9x99 today"],
        ]);

        // "9.99" is a literal substring: the "." matches a dot, not any char, so the
        // "9x99" line is excluded (a regex "." would have matched both).
        const matches = await readUntil(appStore, namespace, "0", 1, undefined, "9.99");
        expect(matches.map((entry) => entry.event.message)).toEqual(["price is 9.99 today"]);
    });

    it("rejects a filter longer than the max length", async () => {
        await expect(appStore.readBatch("preview-acme-api-pr-15", "0", undefined, "x".repeat(201))).rejects.toThrow(
            /Filter too long/,
        );
    });
});
