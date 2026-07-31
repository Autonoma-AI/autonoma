import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WrittenTest } from "../../src/agents/05-test-generator/review";

// The pipeline's job is scheduling, not reviewing - stub the reviewer so these
// tests are about overlap, de-duplication and draining. The handoff CONTRACT is
// covered separately in write-test-review-handoff.test.ts, with both real sides.
const reviewOneTest = vi.hoisted(() => vi.fn());
const readDataContract = vi.hoisted(() => vi.fn());
vi.mock("../../src/agents/05-test-generator/review", () => ({ reviewOneTest, readDataContract }));

const { ReviewPipeline } = await import("../../src/agents/05-test-generator/review-pipeline");

beforeAll(() => {
    process.env.DONT_TRACK = "1";
});

function written(relativePath: string): WrittenTest {
    return { relativePath, content: `# ${relativePath}`, flow: "core" };
}

function verdict(test: WrittenTest) {
    return { relativePath: test.relativePath, content: test.content, dimensions: {}, failedDimensions: [] };
}

const FAR_FUTURE = Date.now() + 60_000;

async function newPipeline(deadline = FAR_FUTURE) {
    const dir = await mkdtemp(join(tmpdir(), "review-pipeline-"));
    return new ReviewPipeline(dir, "/project", "model", deadline);
}

describe("ReviewPipeline", () => {
    beforeAll(() => {
        readDataContract.mockResolvedValue("## Test data");
    });

    it("reviews submitted tests and returns their verdicts on drain", async () => {
        reviewOneTest.mockImplementation(async ({ test }: { test: WrittenTest }) => verdict(test));
        const pipeline = await newPipeline();

        pipeline.submit(written("a.md"));
        pipeline.submit(written("b.md"));
        const results = await pipeline.drain();

        expect(results.map((r) => r.relativePath).sort()).toEqual(["a.md", "b.md"]);
    });

    it("reviews the content it was handed, not something re-read from disk", async () => {
        reviewOneTest.mockImplementation(async ({ test }: { test: WrittenTest }) => verdict(test));
        reviewOneTest.mockClear();
        const pipeline = await newPipeline();

        pipeline.submit({ relativePath: "a.md", content: "EXACT CONTENT", flow: "core" });
        await pipeline.drain();

        expect(reviewOneTest.mock.calls[0]?.[0]?.test).toMatchObject({ content: "EXACT CONTENT", flow: "core" });
    });

    it("loads the data contract once, not per test", async () => {
        reviewOneTest.mockImplementation(async ({ test }: { test: WrittenTest }) => verdict(test));
        readDataContract.mockClear();
        const pipeline = await newPipeline();

        for (const path of ["a.md", "b.md", "c.md", "d.md", "e.md"]) pipeline.submit(written(path));
        await pipeline.drain();

        expect(readDataContract).toHaveBeenCalledTimes(1);
        expect(reviewOneTest.mock.calls[0]?.[0]?.dataContract).toBe("## Test data");
    });

    it("never blocks the caller - submit returns before the review resolves", async () => {
        reviewOneTest.mockImplementation(async ({ test }: { test: WrittenTest }) => {
            await new Promise((res) => setTimeout(res, 200));
            return verdict(test);
        });
        const pipeline = await newPipeline();

        const before = Date.now();
        pipeline.submit(written("slow.md"));

        // The generator moves on immediately; only drain() waits.
        expect(Date.now() - before).toBeLessThan(50);
        await expect(pipeline.drain()).resolves.toHaveLength(1);
    });

    it("caps how many reviews run at once", async () => {
        let inFlight = 0;
        let peak = 0;
        reviewOneTest.mockImplementation(async ({ test }: { test: WrittenTest }) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((res) => setTimeout(res, 5));
            inFlight--;
            return verdict(test);
        });
        const pipeline = await newPipeline();

        for (let i = 0; i < 12; i++) pipeline.submit(written(`t${i}.md`));
        await pipeline.drain();

        expect(peak).toBeLessThanOrEqual(4);
    });

    it("reviews a test only once even if submitted twice", async () => {
        reviewOneTest.mockImplementation(async ({ test }: { test: WrittenTest }) => verdict(test));
        reviewOneTest.mockClear();
        const pipeline = await newPipeline();

        pipeline.submit(written("a.md"));
        pipeline.submit(written("a.md"));
        await pipeline.drain();

        expect(reviewOneTest).toHaveBeenCalledTimes(1);
    });

    it("survives a reviewer that throws, so generation is never taken down with it", async () => {
        reviewOneTest.mockImplementation(async ({ test }: { test: WrittenTest }) => {
            if (test.relativePath === "bad.md") throw new Error("reviewer exploded");
            return verdict(test);
        });
        const pipeline = await newPipeline();

        pipeline.submit(written("bad.md"));
        pipeline.submit(written("good.md"));
        const results = await pipeline.drain();

        expect(results.map((r) => r.relativePath)).toEqual(["good.md"]);
    });

    it("starts nothing new once the deadline has passed", async () => {
        reviewOneTest.mockClear();
        const pipeline = await newPipeline(Date.now() - 1);

        pipeline.submit(written("a.md"));
        const results = await pipeline.drain();

        expect(reviewOneTest).not.toHaveBeenCalled();
        expect(results).toEqual([]);
    });

    it("ignores submissions after drain, so the fix cycles own the suite alone", async () => {
        reviewOneTest.mockClear();
        const pipeline = await newPipeline();

        await pipeline.drain();
        pipeline.submit(written("a.md"));

        expect(reviewOneTest).not.toHaveBeenCalled();
    });
});
