import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const reviewed: string[] = [];
/** Wall clock each mocked review pass burns, so the deadline can be reached. */
let msPerPass = 0;

vi.mock("../../src/agents/05-test-generator/review-pass", () => ({
    runReviewPass: async (_content: string, testPath: string) => {
        reviewed.push(testPath);
        if (msPerPass > 0) vi.setSystemTime(Date.now() + msPerPass);
        return { structuralValidity: { pass: true, evidence: "checked" } };
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
});
