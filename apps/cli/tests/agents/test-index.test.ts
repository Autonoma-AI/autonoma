import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CoverageState, type FeatureNode } from "../../src/agents/05-test-generator/graph";
import { CRITICALITY_LEVELS } from "../../src/agents/05-test-generator/validation";
import { generateIndex } from "../../src/agents/05-test-generator/write-index";
import { INVALID_DIR, TEST_INDEX_FILE, TESTS_DIR } from "../../src/core/test-files";

const TEST_BODY = `---
title: "A test"
criticality: high
flow: "checkout"
---

**Steps**
1. click: the button
2. type: a value
`;

let dir: string;

async function writeTest(relPath: string): Promise<void> {
    const abs = join(dir, TESTS_DIR, relPath);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, TEST_BODY, "utf-8");
}

function node(id: string): FeatureNode {
    return { id, name: id, sourceFiles: [], parentId: undefined, depth: 0, status: "queued" };
}

/** The state the BFS run ended with - deliberately out of step with disk. */
function staleState(): CoverageState {
    const state = new CoverageState();
    state.enqueue(node("checkout"));
    state.markTested("checkout", [
        `${TESTS_DIR}/checkout/pay.md`,
        // Deleted by the review cycle after the tally recorded it.
        `${TESTS_DIR}/checkout/removed.md`,
    ]);
    return state;
}

async function indexFrontmatter(): Promise<string> {
    return await readFile(join(dir, TESTS_DIR, TEST_INDEX_FILE), "utf-8");
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "autonoma-index-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("the test suite index", () => {
    test("counts the tests that exist, not the ones the generator tallied", async () => {
        await writeTest("checkout/pay.md");
        // Written by journey generation, which runs after the BFS tally closes.
        await writeTest("journeys/signup-to-purchase.md");

        await generateIndex(dir, staleState());

        const index = await indexFrontmatter();
        expect(index).toContain("total_tests: 2");
        expect(index).toContain("signup-to-purchase.md");
        // The tally still lists this one; the review cycle deleted it.
        expect(index).not.toContain("removed.md");
    });

    test("quarantined tests are not part of the suite", async () => {
        await writeTest("checkout/pay.md");
        await writeTest(`${INVALID_DIR}/broken.md`);

        await generateIndex(dir, staleState());

        const index = await indexFrontmatter();
        expect(index).toContain("total_tests: 1");
        expect(index).not.toContain("broken.md");
    });

    test("the index never counts itself", async () => {
        await writeTest("checkout/pay.md");
        await generateIndex(dir, staleState());
        // Regenerating over an existing index must not inflate the count.
        await generateIndex(dir, staleState());

        expect(await indexFrontmatter()).toContain("total_tests: 1");
    });
});

describe("suite gaps", () => {
    test("names the features the run produced no test for", async () => {
        await writeTest("checkout/pay.md");

        const state = new CoverageState();
        state.enqueue({ ...node("checkout"), routePath: "/checkout" });
        state.enqueue({ ...node("refunds"), name: "Refunds", routePath: "/refunds" });
        state.nextNode();
        state.markTested("checkout", [`${TESTS_DIR}/checkout/pay.md`]);
        state.nextNode(); // walks refunds
        state.nextNode(); // moves on without a test - auto-skipped

        await generateIndex(dir, state);
        const index = await readFile(join(dir, TESTS_DIR, TEST_INDEX_FILE), "utf-8");

        expect(index).toContain("features_without_tests: 1");
        expect(index).toContain("## Features with no tests");
        expect(index).toContain("- Refunds (/refunds)");
        expect(index).not.toContain("- checkout (/checkout)");
    });

    test("names the tests the review cycle lost", async () => {
        await writeTest("checkout/pay.md");

        const state = new CoverageState();
        state.enqueue(node("checkout"));
        state.nextNode();
        state.markTested("checkout", [`${TESTS_DIR}/checkout/pay.md`]);

        await generateIndex(dir, state, { lost: new Set([`${TESTS_DIR}/checkout/refund.md`]) });
        const index = await readFile(join(dir, TESTS_DIR, TEST_INDEX_FILE), "utf-8");

        expect(index).toContain("tests_lost_in_review: 1");
        expect(index).toContain("## Tests lost in review");
        expect(index).toContain(`- ${TESTS_DIR}/checkout/refund.md`);
    });

    test("says nothing when there is no gap to report", async () => {
        await writeTest("checkout/pay.md");

        const state = new CoverageState();
        state.enqueue(node("checkout"));
        state.nextNode();
        state.markTested("checkout", [`${TESTS_DIR}/checkout/pay.md`]);

        await generateIndex(dir, state);
        const index = await readFile(join(dir, TESTS_DIR, TEST_INDEX_FILE), "utf-8");

        expect(index).toContain("features_without_tests: 0");
        expect(index).toContain("tests_lost_in_review: 0");
        expect(index).not.toContain("## Features with no tests");
        expect(index).not.toContain("## Tests lost in review");
    });
});

describe("criticality tally", () => {
    test("reports a row per canonical level, in canonical order", async () => {
        await writeTest("checkout/pay.md");

        const state = new CoverageState();
        state.enqueue(node("checkout"));
        state.nextNode();
        state.markTested("checkout", [`${TESTS_DIR}/checkout/pay.md`]);

        await generateIndex(dir, state);
        const index = await readFile(join(dir, TESTS_DIR, TEST_INDEX_FILE), "utf-8");

        // Derived from the schema's own levels, so a level added or renamed there
        // cannot silently vanish from the index.
        const rows = [...index.matchAll(/^ {2}(\w+): \d+$/gm)].map((m) => m[1]);
        expect(rows).toEqual([...CRITICALITY_LEVELS]);
        expect(index).toContain("  high: 1");
    });
});
