import type { CreatedTest, SnapshotChange } from "./snapshot-types";

export type EntryCategory = "added" | "modified" | "checked" | "removed";

export interface TestEntry {
    urlId: string;
    category: EntryCategory;
    testName: string;
    testSlug?: string;
    reasoning?: string;
    plan?: string;
    previousPlan?: string;
    generation?: { id: string; status: string };
    /**
     * What the analysis run concluded about this test: the terminal verdict, its one-line account, and the ids to
     * open the finding and the run that produced it. Absent on a snapshot the pipeline never ran.
     */
    verdict?: {
        category: string;
        headline: string;
        findingId: string;
        generationId: string;
        /** Whether the run rewrote this test's plan and re-ran it before reaching the verdict. */
        selfHealed?: boolean;
    };
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
    createdTests,
}: {
    changes: SnapshotChange[];
    createdTests: CreatedTest[];
}): Section[] {
    const createdByTestCaseId = new Map(createdTests.map((t) => [t.testCase.id, t]));

    const added: TestEntry[] = [];
    const modified: TestEntry[] = [];
    const removed: TestEntry[] = [];

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
            continue;
        }
        if (change.type === "updated") {
            modified.push({
                urlId: change.testCaseId,
                category: "modified",
                testName: change.testCaseName,
                testSlug: change.testCaseSlug,
                plan: change.plan,
                previousPlan: change.previousPlan,
            });
            continue;
        }
        removed.push({
            urlId: change.testCaseId,
            category: "removed",
            testName: change.testCaseName,
            testSlug: change.testCaseSlug,
            previousPlan: change.previousPlan,
        });
    }

    return [
        { title: "Added", entries: added },
        { title: "Modified", entries: modified },
        { title: "Removed", entries: removed },
    ];
}

function createdGeneration(created: CreatedTest | undefined): TestEntry["generation"] {
    if (created?.generation == null) return undefined;
    return { id: created.generation.id, status: created.generation.status };
}
