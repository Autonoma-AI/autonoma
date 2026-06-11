import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildLogEntry } from "../../src/build-log-event";
import { LokiBuildLogSink } from "../../src/loki-build-log-sink";
import { LokiLogStore } from "../../src/loki-log-store";

/**
 * Exercises the full build-log producer -> consumer pair against a real Loki
 * (Testcontainers): events appended through LokiBuildLogSink must come back
 * out of LokiLogStore("build") in order with kind/app intact - the exact path
 * the previewkit worker (write) and the apps/api SSE relay (read) use when
 * PREVIEWKIT_BUILD_LOG_STORE=loki. Run with `pnpm test:integration`.
 */
describe("LokiBuildLogSink (integration)", () => {
    let container: StartedTestContainer;
    let baseUrl: string;
    let buildStore: LokiLogStore;

    beforeAll(async () => {
        container = await new GenericContainer("grafana/loki:3.4.1")
            .withExposedPorts(3100)
            .withWaitStrategy(Wait.forHttp("/ready", 3100).withStartupTimeout(120_000))
            .start();
        baseUrl = `http://${container.getHost()}:${container.getMappedPort(3100)}`;
        buildStore = new LokiLogStore(baseUrl, "build");
    }, 130_000);

    afterAll(async () => {
        await container?.stop();
    });

    /** Ingestion is near-instant but not synchronous; poll briefly to avoid flakes. */
    async function readUntil(namespace: string, minEntries: number): Promise<BuildLogEntry[]> {
        const deadline = Date.now() + 10_000;
        let batch = await buildStore.readBatch(namespace, "0");
        while (batch.length < minEntries && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            batch = await buildStore.readBatch(namespace, "0");
        }
        return batch;
    }

    it("round-trips a build's events through seal to a build-source store, in append order", async () => {
        const sink = new LokiBuildLogSink(baseUrl);
        const namespace = "preview-acme-api-pr-1";

        await sink.append(namespace, { kind: "phase", message: "building-images" });
        await sink.append(namespace, { kind: "log", app: "api", message: "step 1/3\n" });
        await sink.append(namespace, { kind: "log", app: "api", message: "step 2/3\n" });
        await sink.append(namespace, { kind: "status", message: "ready" });
        // seal flushes the buffer (Loki's retention period handles expiry).
        await sink.seal(namespace);

        const entries = await readUntil(namespace, 4);

        expect(entries.map((entry) => entry.event)).toEqual([
            { kind: "phase", message: "building-images" },
            { kind: "log", app: "api", message: "step 1/3\n" },
            { kind: "log", app: "api", message: "step 2/3\n" },
            { kind: "status", message: "ready" },
        ]);

        await sink.close();
    });

    it("close drains buffered lines without a seal", async () => {
        const sink = new LokiBuildLogSink(baseUrl);
        const namespace = "preview-acme-api-pr-2";

        await sink.append(namespace, { kind: "log", app: "web", message: "tail line\n" });
        await sink.close();

        const entries = await readUntil(namespace, 1);
        expect(entries.map((entry) => entry.event.message)).toEqual(["tail line\n"]);
    });

    it("never throws when Loki is unreachable - the build must survive a sink outage", async () => {
        const sink = new LokiBuildLogSink("http://127.0.0.1:9");
        const namespace = "preview-acme-api-pr-3";

        await expect(sink.append(namespace, { kind: "log", message: "x\n" })).resolves.toBeUndefined();
        await expect(sink.seal(namespace)).resolves.toBeUndefined();
        await expect(sink.close()).resolves.toBeUndefined();
    });
});
