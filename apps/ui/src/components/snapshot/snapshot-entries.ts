import type { AffectedTest, CreatedTest, SnapshotChange } from "./diffs-timeline-types";

export type EntryCategory = "added" | "modified" | "checked" | "removed";

export interface TestEntry {
    urlId: string;
    category: EntryCategory;
    testName: string;
    testSlug?: string;
    reasoning?: string;
    plan?: string;
    previousPlan?: string;
    generation?: { id: string; status: string; reviewReasoning?: string };
}

export interface Section {
    title: string;
    hint?: string;
    entries: TestEntry[];
}

export const CATEGORY: Record<
    EntryCategory,
    { label: string; variant: "success" | "warn" | "critical" | "high" | "outline" | "neutral" }
> = {
    added: { label: "added", variant: "success" },
    modified: { label: "modified", variant: "warn" },
    checked: { label: "checked", variant: "neutral" },
    removed: { label: "removed", variant: "critical" },
};

export function buildSections({
    changes,
    affectedTests,
    createdTests,
}: {
    changes: SnapshotChange[];
    affectedTests: AffectedTest[];
    createdTests: CreatedTest[];
}): Section[] {
    const affectedByTestCaseId = new Map(affectedTests.map((t) => [t.testCase.id, t]));
    const createdByTestCaseId = new Map(createdTests.map((t) => [t.testCase.id, t]));

    const added: TestEntry[] = [];
    const modified: TestEntry[] = [];
    const checked: TestEntry[] = [];
    const removed: TestEntry[] = [];

    const surfaced = new Set<string>();

    for (const change of changes) {
        if (change.type === "added") {
            // Fall back to the change's plan when no created-test record exists (legacy snapshots).
            const created = createdByTestCaseId.get(change.testCaseId);
            added.push({
                urlId: change.testCaseId,
                category: "added",
                testName: change.testCaseName,
                testSlug: change.testCaseSlug,
                reasoning: created?.description,
                plan: created?.plan ?? change.plan,
                generation: createdGeneration(created),
            });
            surfaced.add(change.testCaseId);
            continue;
        }
        if (change.type === "updated") {
            const affected = affectedByTestCaseId.get(change.testCaseId);
            modified.push({
                urlId: change.testCaseId,
                category: "modified",
                testName: change.testCaseName,
                testSlug: change.testCaseSlug,
                reasoning: affected?.reasoning,
                plan: change.plan,
                previousPlan: change.previousPlan,
                generation: affectedGeneration(affected),
            });
            surfaced.add(change.testCaseId);
            continue;
        }
        removed.push({
            urlId: change.testCaseId,
            category: "removed",
            testName: change.testCaseName,
            testSlug: change.testCaseSlug,
            previousPlan: change.previousPlan,
        });
        surfaced.add(change.testCaseId);
    }

    // Tests flagged as potentially affected by the diff but never edited (no "updated"
    // change was emitted for them). They were regenerated to confirm the change did not
    // break them, so they are "checked", not "modified".
    for (const affected of affectedTests) {
        if (surfaced.has(affected.testCase.id)) continue;
        checked.push({
            urlId: affected.testCase.id,
            category: "checked",
            testName: affected.testCase.name,
            testSlug: affected.testCase.slug,
            reasoning: affected.reasoning,
            generation: affectedGeneration(affected),
        });
        surfaced.add(affected.testCase.id);
    }

    return [
        { title: "Added", entries: added },
        { title: "Modified", entries: modified },
        {
            title: "Checked",
            hint: "Regenerated because the change might affect them; their definitions were not modified.",
            entries: checked,
        },
        { title: "Removed", entries: removed },
    ];
}

function createdGeneration(created: CreatedTest | undefined): TestEntry["generation"] {
    if (created?.generation == null) return undefined;
    return {
        id: created.generation.id,
        status: created.generation.status,
        reviewReasoning: created.generation.reviewReasoning ?? undefined,
    };
}

function affectedGeneration(t: AffectedTest | undefined): TestEntry["generation"] {
    if (t?.generation == null) return undefined;
    return {
        id: t.generation.id,
        status: t.generation.status,
        reviewReasoning: t.generation.generationReview?.reasoning ?? undefined,
    };
}
