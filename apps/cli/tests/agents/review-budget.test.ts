import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const reviewed: string[] = [];
/** Wall clock each mocked review pass burns, so the deadline can be reached. */
let msPerPass = 0;
/** Whether the mocked review fails every test, so findings exist to carry. */
let failEverything = false;

vi.mock("../../src/agents/05-test-generator/review-pass", () => ({
    runReviewPass: async (_content: string, testPath: string) => {
        reviewed.push(testPath);
        if (msPerPass > 0) vi.setSystemTime(Date.now() + msPerPass);
        const pass = !failEverything;
        return { structuralValidity: { pass, evidence: pass ? "checked" : "no assertion" } };
    },
}));

const { runConsolidatedReview } = await import("../../src/agents/05-test-generator/review");

const MODEL = {} as Parameters<typeof runConsolidatedReview>[2];

describe("review budget", () => {
    let outputDir: string;

    async function writeTest(relPath: string) {
        const abs = join(outputDir, "qa-tests", relPath);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, `---\nflow: "core"\n---\n\n1. click: Save\n`, "utf-8");
    }

    beforeEach(async () => {
        outputDir = await mkdtemp(join(tmpdir(), "review-budget-"));
        reviewed.length = 0;
        msPerPass = 0;
        failEverything = false;
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await rm(outputDir, { recursive: true });
    });

    test("reviews every test when there is budget", async () => {
        for (let i = 0; i < 6; i++) await writeTest(`admin/test-${i}.md`);

        const result = await runConsolidatedReview(outputDir, "/project", MODEL, Date.now() + 60_000);

        expect(new Set(reviewed).size).toBe(6);
        expect(result.ranOutOfTime).toBe(false);
    });

    test("stops between batches once the deadline passes", async () => {
        // 4 tests run concurrently, so the deadline is only checked every 4.
        for (let i = 0; i < 12; i++) await writeTest(`admin/test-${i}.md`);
        msPerPass = 1_000;

        const result = await runConsolidatedReview(outputDir, "/project", MODEL, Date.now() + 10_000);

        expect(result.ranOutOfTime).toBe(true);
        expect(new Set(reviewed).size).toBeLessThan(12);
    });

    test("reviews nothing when the budget is already spent", async () => {
        for (let i = 0; i < 4; i++) await writeTest(`admin/test-${i}.md`);

        const result = await runConsolidatedReview(outputDir, "/project", MODEL, Date.now() - 1);

        expect(reviewed).toEqual([]);
        expect(result.ranOutOfTime).toBe(true);
        // Nothing reviewed means nothing to fix - the suite passes through intact.
        expect(result.feedback).toEqual([]);
    });

    test("a scan cut short still hands back everything it judged", async () => {
        for (let i = 0; i < 12; i++) await writeTest(`admin/test-${i}.md`);
        // Reviewed tests fail, then the deadline stops the scan. Those findings
        // are the whole reason the caller reserves budget to act on them:
        // discarding them spends the full cost of reviewing for none of the
        // benefit.
        failEverything = true;
        msPerPass = 1_000;

        const result = await runConsolidatedReview(outputDir, "/project", MODEL, Date.now() + 10_000);

        expect(result.ranOutOfTime).toBe(true);
        expect(new Set(reviewed).size).toBeLessThan(12);
        expect(result.feedback.length).toBeGreaterThan(0);
        expect(result.failed).toBe(result.feedback.length);
    });
});

describe("review progress callback", () => {
    let outputDir: string;

    async function writeTest(relPath: string) {
        const abs = join(outputDir, "qa-tests", relPath);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, `---\nflow: "core"\n---\n\n1. click: Save\n`, "utf-8");
    }

    beforeEach(async () => {
        outputDir = await mkdtemp(join(tmpdir(), "review-progress-"));
        reviewed.length = 0;
        msPerPass = 0;
        failEverything = false;
    });

    afterEach(async () => {
        await rm(outputDir, { recursive: true, force: true });
    });

    test("calls onProgress with (0, total) before the scan starts", async () => {
        for (let i = 0; i < 4; i++) await writeTest(`admin/test-${i}.md`);

        const calls: { reviewed: number; total: number }[] = [];
        await runConsolidatedReview(
            outputDir,
            "/project",
            MODEL,
            Date.now() + 60_000,
            new Set(),
            [],
            (reviewed, total) => calls.push({ reviewed, total }),
        );

        // First call is (0, total) to signal the review has started.
        expect(calls[0]).toEqual({ reviewed: 0, total: 16 });
    });

    test("calls onProgress after each (test, rubric) job settles", async () => {
        for (let i = 0; i < 3; i++) await writeTest(`admin/test-${i}.md`);

        const calls: number[] = [];
        await runConsolidatedReview(outputDir, "/project", MODEL, Date.now() + 60_000, new Set(), [], (reviewed) =>
            calls.push(reviewed),
        );

        // 3 tests × 4 rubrics = 12 jobs. First call is (0, 12), then 1..12.
        expect(calls).toHaveLength(13);
        expect(calls[0]).toBe(0);
        expect(calls.at(-1)).toBe(12);
    });
});
