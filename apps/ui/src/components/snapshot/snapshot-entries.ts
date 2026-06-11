import type {
    AffectedTest,
    ExecutedTest,
    QuarantinedTest,
    SnapshotChange,
    TestCandidate,
} from "./diffs-timeline-types";

export type EntryCategory =
    | "added"
    | "modified"
    | "removed"
    | "newly-quarantined"
    | "proposed-pending"
    | "proposed-rejected";

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
        reason: "application_bug" | "engine_limitation";
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
    { label: string; variant: "success" | "warn" | "critical" | "high" | "outline" }
> = {
    added: { label: "added", variant: "success" },
    modified: { label: "modified", variant: "warn" },
    removed: { label: "removed", variant: "critical" },
    "newly-quarantined": { label: "newly quarantined", variant: "high" },
    "proposed-pending": { label: "proposed", variant: "outline" },
    "proposed-rejected": { label: "rejected", variant: "outline" },
};

export function buildSections({
    changes,
    affectedTests,
    testCandidates,
    quarantinedTests,
    executedTests,
}: {
    changes: SnapshotChange[];
    affectedTests: AffectedTest[];
    testCandidates: TestCandidate[];
    quarantinedTests: QuarantinedTest[];
    executedTests: ExecutedTest[];
}): Section[] {
    const affectedByTestCaseId = new Map(affectedTests.map((t) => [t.testCase.id, t]));
    const executedByTestCaseId = new Map(executedTests.map((e) => [e.testCase.id, e]));
    const candidateByAcceptedTestCaseId = new Map<string, TestCandidate>();
    for (const c of testCandidates) {
        if (c.acceptedTestCase != null) candidateByAcceptedTestCaseId.set(c.acceptedTestCase.id, c);
    }
    const quarantineByTestCaseId = new Map(quarantinedTests.map((q) => [q.testCase.id, q]));

    const added: TestEntry[] = [];
    const modified: TestEntry[] = [];
    const removed: TestEntry[] = [];
    const newlyQuarantined: TestEntry[] = [];
    const proposed: TestEntry[] = [];

    const surfaced = new Set<string>();

    for (const change of changes) {
        if (change.type === "added") {
            const candidate = candidateByAcceptedTestCaseId.get(change.testCaseId);
            added.push({
                urlId: change.testCaseId,
                category: "added",
                testName: change.testCaseName,
                testSlug: change.testCaseSlug,
                reasoning: candidate?.reasoning,
                plan: change.plan,
                generation: candidateGeneration(candidate),
                run: candidateRun(candidate),
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

    for (const affected of affectedTests) {
        if (surfaced.has(affected.testCase.id)) continue;
        modified.push({
            urlId: affected.testCase.id,
            category: "modified",
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

    for (const c of testCandidates) {
        if (c.acceptedTestCase != null && surfaced.has(c.acceptedTestCase.id)) continue;
        if (c.status === "accepted" && c.acceptedTestCase == null) continue;
        const urlId = c.acceptedTestCase?.id ?? `proposal-${c.id}`;
        proposed.push({
            urlId,
            category: c.status === "rejected" ? "proposed-rejected" : "proposed-pending",
            testName: c.acceptedTestCase?.name ?? c.name,
            testSlug: c.acceptedTestCase?.slug,
            reasoning: c.reasoning,
            plan: c.instruction,
        });
    }

    return [
        { title: "Added", entries: added },
        { title: "Modified", entries: modified },
        { title: "Removed", entries: removed },
        { title: "Newly quarantined", entries: newlyQuarantined },
        {
            title: "Proposed (not added)",
            hint: "Proposals that were not added to the suite (pending or rejected).",
            entries: proposed,
        },
    ];
}

function candidateGeneration(c: TestCandidate | undefined): TestEntry["generation"] {
    if (c?.generation == null) return undefined;
    return {
        id: c.generation.id,
        status: c.generation.status,
        reviewReasoning: c.generation.reviewReasoning ?? undefined,
    };
}

function candidateRun(c: TestCandidate | undefined): TestEntry["run"] {
    if (c?.run == null) return undefined;
    return {
        id: c.run.id,
        status: c.run.status,
        verdict: c.run.verdict ?? undefined,
        reviewReasoning: c.run.reviewReasoning ?? undefined,
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
