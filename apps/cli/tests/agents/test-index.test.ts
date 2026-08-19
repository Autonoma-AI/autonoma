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
    test("names the pages the run produced no test for", async () => {
        await writeTest("checkout/pay.md");

        const state = new CoverageState();
        state.enqueue({ ...node("checkout"), name: "Checkout", routePath: "/checkout" });
        state.enqueue({ ...node("refunds"), name: "Refunds", routePath: "/refunds" });
        state.markTested("checkout", [`${TESTS_DIR}/checkout/pay.md`]);

        await generateIndex(dir, state);
        const index = await readFile(join(dir, TESTS_DIR, TEST_INDEX_FILE), "utf-8");

        expect(index).toContain("pages_without_tests: 1");
        expect(index).toContain("## Pages with no tests");
        expect(index).toContain("- Refunds (/refunds)");
        expect(index).not.toContain("- Checkout (/checkout)");
    });

    test("a page is covered when a feature beneath it holds the test", async () => {
        // Attribution collapses onto the page root: the sub-feature's test rolls
        // up to its page, so the page is covered even though the feature node was
        // the one that recorded it.
        await writeTest("workspace/create.md");

        const state = new CoverageState();
        state.enqueue({ ...node("workspace"), name: "Workspace", routePath: "/workspace" });
        state.enqueue({
            ...node("workspace-create"),
            name: "Create workspace",
            routePath: "/workspace",
            parentId: "workspace",
            depth: 1,
        });
        state.markTested("workspace-create", [`${TESTS_DIR}/workspace/create.md`]);

        await generateIndex(dir, state);
        const index = await readFile(join(dir, TESTS_DIR, TEST_INDEX_FILE), "utf-8");

        expect(index).toContain("pages_without_tests: 0");
        expect(index).not.toContain("## Pages with no tests");
    });

    test("nested-route pages are matched by page root, not folder name", async () => {
        // The bug this pins: a page id joins route segments with "-"
        // (settings-notifications), but tests live in a nested folder whose first
        // segment is just "settings", so a folder-name check reported the covered
        // page as a gap. Coverage is rolled up by page root instead - so the
        // covered page is not a gap, and its uncovered sibling still is.
        await writeTest("settings/notifications/toggle.md");

        const state = new CoverageState();
        state.enqueue({
            ...node("settings-notifications"),
            name: "Notifications",
            routePath: "/settings/notifications",
        });
        state.enqueue({ ...node("settings-billing"), name: "Billing", routePath: "/settings/billing" });
        state.markTested("settings-notifications", [`${TESTS_DIR}/settings/notifications/toggle.md`]);

        await generateIndex(dir, state);
        const index = await readFile(join(dir, TESTS_DIR, TEST_INDEX_FILE), "utf-8");

        expect(index).toContain("pages_without_tests: 1");
        expect(index).toContain("- Billing (/settings/billing)");
        expect(index).not.toContain("- Notifications (/settings/notifications)");
    });

    test("a page with no tests is still a gap when a sibling page is covered", async () => {
        // A covered page must not mask an uncovered one: reports has no test and
        // is reported even though its sibling dashboard is covered.
        await writeTest("dashboard/overview.md");

        const state = new CoverageState();
        state.enqueue({ ...node("dashboard"), name: "Dashboard", routePath: "/dashboard" });
        state.enqueue({ ...node("reports"), name: "Reports", routePath: "/reports" });
        state.markTested("dashboard", [`${TESTS_DIR}/dashboard/overview.md`]);

        await generateIndex(dir, state);
        const index = await readFile(join(dir, TESTS_DIR, TEST_INDEX_FILE), "utf-8");

        expect(index).toContain("pages_without_tests: 1");
        expect(index).toContain("## Pages with no tests");
        expect(index).toContain("- Reports (/reports)");
        expect(index).not.toContain("- Dashboard (/dashboard)");
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

        expect(index).toContain("pages_without_tests: 0");
        expect(index).toContain("tests_lost_in_review: 0");
        expect(index).not.toContain("## Pages with no tests");
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
