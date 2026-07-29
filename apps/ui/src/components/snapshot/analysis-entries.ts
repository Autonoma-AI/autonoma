import { ANALYSIS_VERDICT, type AnalysisFindingView } from "@autonoma/types";
import type { SnapshotChange } from "./diffs-timeline-types";
import type { EntryCategory, Section, TestEntry } from "./snapshot-entries";

/**
 * Categorizes one test the analysis run investigated, straight from what the run recorded about it. `origin` says
 * how the test entered the run and a second classification says the run rewrote it, so no plan-id archaeology is
 * needed - and a selected test the run left alone still appears (as `checked`), which a plan diff cannot show.
 */
function categoryOf(finding: AnalysisFindingView): EntryCategory {
    // An `invalid_test` verdict removed the test's assignment - it belongs under Removed regardless of how it entered
    // the run (a proposed test the run could not establish is removed just the same).
    if (finding.category === "invalid_test") return "removed";
    if (finding.origin === "proposed") return "added";
    // Named by verdict rather than by presentation tier, because what matters here is this verdict's BEHAVIOR: a kept
    // `plan_mismatch` restores the plan its self-heal replaced, so the run left the test as it found it - checked, not
    // modified, even though it self-healed. Only a rewrite the run KEPT (a passed re-run) is a real modification.
    if (finding.category === ANALYSIS_VERDICT.plan_mismatch) return "checked";
    return wasSelfHealed(finding) ? "modified" : "checked";
}

/** The run rewrote this test's plan exactly when it classified it more than once. */
function wasSelfHealed(finding: AnalysisFindingView): boolean {
    return finding.classifications.length > 1;
}

/**
 * Builds the suite-changes sections for an authoritative snapshot: one entry per `AnalysisFinding`, so every test
 * the run touched is listed with its verdict, why it was selected, and links to its finding and generation.
 *
 * `changes` (the snapshot's plan diff against its predecessor) is consulted only for the plan TEXT - the finding
 * carries the plan the run was checked against but not what it replaced, and a before/after is the point of a
 * `modified` row.
 */
export function buildAnalysisSections({
    findings,
    changes,
}: {
    findings: AnalysisFindingView[];
    changes: SnapshotChange[];
}): Section[] {
    const changeByTestCaseId = new Map(changes.map((change) => [change.testCaseId, change] as const));

    const byCategory: Record<EntryCategory, TestEntry[]> = { added: [], modified: [], checked: [], removed: [] };
    for (const finding of findings) {
        const category = categoryOf(finding);
        byCategory[category].push(toEntry(finding, category, changeByTestCaseId.get(finding.testCase.id)));
    }

    return [
        { title: "Added", entries: byCategory.added },
        { title: "Modified", entries: byCategory.modified },
        {
            title: "Checked",
            hint: "Selected because the change might affect them; the run did not need to modify their definitions.",
            entries: byCategory.checked,
        },
        { title: "Removed", entries: byCategory.removed },
    ];
}

function toEntry(finding: AnalysisFindingView, category: EntryCategory, change: SnapshotChange | undefined): TestEntry {
    return {
        // Routed by finding id, matching every other analysis surface - the finding IS the run's record for this
        // test, and a `removed` test has no assignment left to key on.
        urlId: finding.id,
        category,
        testName: finding.testCase.name,
        testSlug: finding.testCase.slug,
        reasoning: finding.selectionReason,
        plan: finding.plan ?? planOf(change),
        previousPlan: previousPlanOf(change),
        verdict: {
            category: finding.category,
            headline: finding.headline,
            findingId: finding.id,
            generationId: finding.generationId,
            selfHealed: wasSelfHealed(finding),
        },
    };
}

function planOf(change: SnapshotChange | undefined): string | undefined {
    if (change == null) return undefined;
    return change.type === "removed" ? undefined : change.plan;
}

function previousPlanOf(change: SnapshotChange | undefined): string | undefined {
    if (change == null) return undefined;
    return change.type === "added" ? undefined : change.previousPlan;
}
