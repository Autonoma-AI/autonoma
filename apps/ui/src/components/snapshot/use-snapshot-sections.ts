import { FULL_SNAPSHOT_DETAIL, useAnalysisReport, useSnapshotDetail } from "lib/query/branches.queries";
import { useMemo } from "react";
import { buildAnalysisSections } from "./analysis-entries";
import { buildSections, type Section, type TestEntry } from "./snapshot-entries";

// Derives the categorized test-change sections for a snapshot. An authoritative snapshot's sections come from the
// analysis run's own findings (one per test it investigated); a diffs snapshot's come from the plan diff plus the
// diffs job's affected/created tests. Lives next to the two builders so the changes-page components can each fetch
// their own data instead of having sections drilled through props - the underlying queries are shared via
// react-query's cache, so calling this in several components is cheap.
export function useSnapshotSections(snapshotId: string): Section[] {
    const { data } = useSnapshotDetail(snapshotId, FULL_SNAPSHOT_DETAIL);
    const { data: analysisReport } = useAnalysisReport(snapshotId);
    const { changes, diffsJob, createdTests } = data;
    const findings = analysisReport?.findings;

    return useMemo(() => {
        if (findings != null) return buildAnalysisSections({ findings, changes });
        return buildSections({ changes, affectedTests: diffsJob.affectedTests, createdTests });
    }, [findings, changes, diffsJob.affectedTests, createdTests]);
}

// Resolves the single test entry addressed by `testId` (its `urlId`) within the snapshot.
export function useSnapshotEntry(snapshotId: string, testId: string): TestEntry | undefined {
    const sections = useSnapshotSections(snapshotId);
    return useMemo(() => sections.flatMap((s) => s.entries).find((e) => e.urlId === testId), [sections, testId]);
}
