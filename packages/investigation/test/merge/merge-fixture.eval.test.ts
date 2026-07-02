import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openModelSession } from "../../src";
import type { BranchEdit, MainSuiteEntry } from "../../src";
import { reconcileMerge } from "../../src";
import type { MergeDecision } from "../../src";

/**
 * A realistic merge-with-main evalset built on REAL production test plans (a document-management suite pulled
 * from prod and client-anonymized - the flows are generic, the client is not named). It stages the merge
 * scenarios that matter after a PR merges - a clean edit, a genuinely-new test, a duplicate, a test main
 * deleted, and (the hard one) a CONFLICT where the branch and main both edited the same test differently -
 * then runs the reconciler on the real model and checks it keeps both intents on the conflict and drops the
 * duplicate. Hits the live OpenAI API, so it only runs with RUN_EVALS=1. Run it with:
 *   RUN_EVALS=1 pnpm --filter @autonoma/investigation exec vitest run test/merge/merge-fixture.eval.test.ts
 */
const RUN = process.env.RUN_EVALS === "1" && process.env.OPENAI_API_KEY != null && process.env.OPENAI_API_KEY !== "";

interface FixturePlan {
    slug: string;
    name: string;
    flow: string;
    plan: string;
}

function loadSuite(): Map<string, FixturePlan> {
    const raw = readFileSync(new URL("./fixtures/documents-suite.json", import.meta.url), "utf8");
    const plans: FixturePlan[] = JSON.parse(raw);
    return new Map(plans.map((plan) => [plan.slug, plan]));
}

/** The one-line summary from a plan's YAML frontmatter - what the real MergeInputsReader puts in the catalog. */
function frontmatterDescription(plan: string): string {
    return plan.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "(no description)";
}

function mainSuite(suite: Map<string, FixturePlan>): MainSuiteEntry[] {
    return [...suite.values()].map((plan) => ({
        slug: plan.slug,
        name: plan.name,
        flow: plan.flow,
        description: frontmatterDescription(plan.plan),
    }));
}

const DUPLICATE_DOCUMENT_PLAN = `---
title: 'Duplicate a document from the context menu'
description: 'Verify a document can be duplicated and the copy appears in the list'
criticality: high
scenario: standard
flow: 'Documents & Document Review'
---

# Test: Duplicate a document from the context menu

## Setup

Using scenario: \`standard\`. Sign in as \`{{admin_email}}\`, go to \`/documents\`.

## Steps

1. Right-click the row \`Globex NDA - v1.docx\`
2. Click \`Duplicate\`
3. Assert a row \`Globex NDA - v1 (copy).docx\` appears in the list
4. Refresh the page
5. Assert the duplicated row is still present

## Expected Result

The document is duplicated and the copy persists.`;

const DUPLICATE_SEARCH_PLAN = `---
title: 'Filter the documents list with the search box'
description: 'Verify typing in the documents search input narrows the list to matches'
criticality: high
scenario: standard
flow: 'Documents & Document Review'
---

# Test: Filter the documents list with the search box

## Setup

Using scenario: \`standard\`. Sign in as \`{{admin_email}}\`, go to \`/documents\`.

## Steps

1. Type a document name fragment into the documents search box
2. Assert only matching rows remain
3. Clear the box and assert the full list returns

## Expected Result

Searching narrows the documents list to matching names.`;

describe.skipIf(!RUN)("eval: merge-with-main on real (anonymized) document plans (gpt-5.5)", () => {
    it("reconciles a mixed PR - clean edit, new test, duplicate, deleted, and a conflict - correctly", async () => {
        const suite = loadSuite();
        const rename = suite.get("006-rename-document-e43b9f32");
        const del = suite.get("007-delete-document-md");
        if (rename == null || del == null) throw new Error("fixture missing expected plans");

        // S1 - clean modification: the PR expanded the rename-confirmation toast copy. Main untouched.
        const renameBranch = rename.plan.replaceAll("`Document renamed`", "`Document renamed successfully`");

        // S2 - CONFLICT on the delete test: the branch adds an assertion that the confirmation dialog warns the
        // action is irreversible, while ANOTHER merged PR renamed the seed document from
        // `Standard MSA Template.docx` to `Standard MSA - v2.docx` throughout the same test.
        const delBranch = del.plan.replace(
            '2. Click "Delete"\n3. Click "Delete" / "Confirm"\n4. Assert the row `Standard MSA Template.docx` is no longer visible\n5. Refresh the page\n6. Assert the row is still gone',
            '2. Click "Delete"\n3. Assert a confirmation dialog appears warning that this action cannot be undone\n4. Click "Delete" / "Confirm"\n5. Assert the row `Standard MSA Template.docx` is no longer visible\n6. Refresh the page\n7. Assert the row is still gone',
        );
        const delMainNow = del.plan.replaceAll("Standard MSA Template.docx", "Standard MSA - v2.docx");

        const edits: BranchEdit[] = [
            {
                kind: "modification",
                ref: rename.slug,
                name: rename.name,
                flow: rename.flow,
                description: frontmatterDescription(rename.plan),
                basePlan: rename.plan,
                proposedPlan: renameBranch,
                mainCurrentPlan: rename.plan, // main did not touch this test
            },
            {
                kind: "modification",
                ref: del.slug,
                name: del.name,
                flow: del.flow,
                description: frontmatterDescription(del.plan),
                basePlan: del.plan,
                proposedPlan: delBranch,
                mainCurrentPlan: delMainNow, // main changed the same test differently
            },
            {
                kind: "modification",
                ref: "legacy-bulk-download",
                name: "Bulk-download selected documents (legacy)",
                flow: "documents",
                description: "the removed bulk-download action",
                basePlan:
                    "---\ntitle: 'Bulk download'\n---\n# Test: Bulk download\n## Steps\n1. Select rows\n2. Click Download",
                proposedPlan:
                    "---\ntitle: 'Bulk download'\n---\n# Test: Bulk download\n## Steps\n1. Select rows\n2. Click Download\n3. Assert a zip downloads",
                mainCurrentPlan: undefined, // main DELETED this test
            },
            {
                kind: "new_test",
                ref: "duplicate-a-document",
                name: "Duplicate a document from the context menu",
                flow: "documents",
                description: "duplicates a document and the copy appears in the list",
                proposedPlan: DUPLICATE_DOCUMENT_PLAN,
            },
            {
                kind: "new_test",
                ref: "filter-documents-with-search",
                name: "Filter the documents list with the search box",
                flow: "documents",
                description: "narrows the documents list via the search box",
                proposedPlan: DUPLICATE_SEARCH_PLAN,
            },
        ];

        const model = openModelSession({ openaiApiKey: process.env.OPENAI_API_KEY ?? "" }).getModel({
            model: "classifier",
            tag: "eval-merge-fixture",
        });
        const plan = await reconcileMerge({ edits, mainSuite: mainSuite(suite), recipeEdits: [] }, { model });

        const byRef = new Map<string, MergeDecision>(plan.decisions.map((decision) => [decision.ref, decision]));
        const report = plan.decisions
            .map((d) => {
                const merged = d.mergedPlan != null ? ` [merged plan: ${d.mergedPlan.length} chars]` : "";
                return `- ${d.ref} → ${d.action.toUpperCase()}${merged}\n    ${d.reason}`;
            })
            .join("\n");
        // eslint-disable-next-line no-console
        console.log(`\n[eval] merge decisions:\n${report}\n`);
        const conflict = byRef.get(del.slug);
        if (conflict?.mergedPlan != null) {
            // eslint-disable-next-line no-console
            console.log(`[eval] conflict merged plan:\n${conflict.mergedPlan}\n`);
        }

        // S1: a clean edit main did not touch is carried in.
        expect(byRef.get(rename.slug)?.action).toBe("apply");

        // S2 (the hard one): the conflict is applied with a MERGED plan that keeps BOTH intents -
        // main's document rename (Standard MSA - v2.docx) AND the branch's new irreversible-warning
        // assertion - without reverting main back to the old `Standard MSA Template.docx`.
        const merged = byRef.get(del.slug);
        expect(merged?.action).toBe("apply");
        expect(merged?.mergedPlan).toBeDefined();
        const mergedPlan = merged?.mergedPlan ?? "";
        expect(mergedPlan).toContain("Standard MSA - v2.docx");
        expect(mergedPlan.toLowerCase()).toContain("cannot be undone");
        expect(mergedPlan).not.toContain("Standard MSA Template.docx");

        // S3: a genuinely new documents feature (duplicate) main does not cover is added.
        expect(byRef.get("duplicate-a-document")?.action).toBe("apply");

        // S4: a new test that duplicates the existing search coverage is dropped.
        expect(byRef.get("filter-documents-with-search")?.action).toBe("skip");

        // S5: a modification whose test main deleted is dropped.
        expect(byRef.get("legacy-bulk-download")?.action).toBe("skip");
    });
});
