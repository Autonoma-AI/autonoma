import type { AffectedTest, CreatedTest, ExecutedTest, QuarantinedTest, SnapshotChange } from "./diffs-timeline-types";

export type EntryCategory = "added" | "modified" | "checked" | "removed" | "newly-quarantined";

export interface TestEntry {
    urlId: string;
    category: EntryCategory;
    testName: string;
    testSlug?: string;
    reasoning?: string;
    plan?: string;
    previousPlan?: string;
    generation?: { id: string; status: string; reviewReasoning?: string };
    run?: { id: string; status: string; verdict?: string; reviewReasoning?: string };
    quarantine?: {
        reason: "application_bug" | "engine_limitation" | "unknown_issue";
        issueId: string;
        bugId?: string;
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
    "newly-quarantined": { label: "newly quarantined", variant: "high" },
};

export function buildSections({
    changes,
    affectedTests,
    createdTests,
    quarantinedTests,
    executedTests,
}: {
    changes: SnapshotChange[];
    affectedTests: AffectedTest[];
    createdTests: CreatedTest[];
    quarantinedTests: QuarantinedTest[];
    executedTests: ExecutedTest[];
}): Section[] {
    const affectedByTestCaseId = new Map(affectedTests.map((t) => [t.testCase.id, t]));
    const executedByTestCaseId = new Map(executedTests.map((e) => [e.testCase.id, e]));
    const createdByTestCaseId = new Map(createdTests.map((t) => [t.testCase.id, t]));
    const quarantineByTestCaseId = new Map(quarantinedTests.map((q) => [q.testCase.id, q]));

    const added: TestEntry[] = [];
    const modified: TestEntry[] = [];
    const checked: TestEntry[] = [];
    const removed: TestEntry[] = [];
    const newlyQuarantined: TestEntry[] = [];

    const surfaced = new Set<string>();

    for (const change of changes) {
        if (change.type === "added") {
            // Fall back to the change's plan + latest executed run when no created-test
            // record exists (legacy snapshots).
            const created = createdByTestCaseId.get(change.testCaseId);
            added.push({
                urlId: change.testCaseId,
                category: "added",
                testName: change.testCaseName,
                testSlug: change.testCaseSlug,
                reasoning: created?.description,
                plan: created?.plan ?? change.plan,
                generation: createdGeneration(created),
                run: createdRun(created) ?? executedRun(executedByTestCaseId.get(change.testCaseId)),
                quarantine: quarantineByTestCaseId.get(change.testCaseId),
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
                run: modifiedRun(affected, executedByTestCaseId.get(change.testCaseId)),
                quarantine: quarantineByTestCaseId.get(change.testCaseId),
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
    // change was emitted for them). They were replayed to confirm the change did not
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
            run: modifiedRun(affected, executedByTestCaseId.get(affected.testCase.id)),
            quarantine: quarantineByTestCaseId.get(affected.testCase.id),
        });
        surfaced.add(affected.testCase.id);
    }

    for (const q of quarantinedTests) {
        if (surfaced.has(q.testCase.id)) continue;
        newlyQuarantined.push({
            urlId: q.testCase.id,
            category: "newly-quarantined",
            testName: q.testCase.name,
            testSlug: q.testCase.slug,
            quarantine: { reason: q.reason, issueId: q.issueId, bugId: q.bugId },
        });
    }

    return [
        { title: "Added", entries: added },
        { title: "Modified", entries: modified },
        {
            title: "Checked",
            hint: "Replayed because the change might affect them; their definitions were not modified.",
            entries: checked,
        },
        { title: "Removed", entries: removed },
        { title: "Newly quarantined", entries: newlyQuarantined },
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

function createdRun(created: CreatedTest | undefined): TestEntry["run"] {
    if (created?.run == null) return undefined;
    return {
        id: created.run.id,
        status: created.run.status,
        verdict: created.run.verdict ?? undefined,
        reviewReasoning: created.run.reviewReasoning ?? undefined,
    };
}

/** The latest executed run for a test case in this snapshot, when one exists. */
function executedRun(executed: ExecutedTest | undefined): TestEntry["run"] {
    if (executed?.runId == null) return undefined;
    return {
        id: executed.runId,
        status: executed.status,
        verdict: executed.verdict ?? undefined,
        reviewReasoning: executed.reviewReasoning ?? undefined,
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

function affectedRun(t: AffectedTest | undefined): TestEntry["run"] {
    if (t?.run == null) return undefined;
    return {
        id: t.run.id,
        status: t.run.status,
        verdict: t.run.runReview?.verdict ?? undefined,
        reviewReasoning: t.run.runReview?.reasoning ?? undefined,
    };
}

// `AffectedTest.run` is pinned to the *initial* replay that detected the test as
// affected and is never re-pointed at the post-fix validation run created by the
// refinement loop. For a modified test the user expects the latest replay, so
// prefer the snapshot's latest executed run for the test case and fall back to
// the initial replay only when no executed run exists yet.
function modifiedRun(t: AffectedTest | undefined, executed: ExecutedTest | undefined): TestEntry["run"] {
    if (executed?.runId != null) {
        return {
            id: executed.runId,
            status: executed.status,
            verdict: executed.verdict ?? undefined,
            reviewReasoning: executed.reviewReasoning ?? undefined,
        };
    }
    return affectedRun(t);
}
