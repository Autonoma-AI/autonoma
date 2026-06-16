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
    ): Promise<Awaited<ReturnType<LokiLogStore["readBatch"]>>> {
        const deadline = Date.now() + 10_000;
        let batch = await store.readBatch(namespace, cursor, app);
        while (batch.length < minEntries && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            batch = await store.readBatch(namespace, cursor, app);
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
});
