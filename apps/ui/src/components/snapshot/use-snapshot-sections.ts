import { useAnalysisJob, useAnalysisReport, useFullSnapshotDetail } from "lib/query/branches.queries";
import { useMemo } from "react";
import { buildAnalysisSections } from "./analysis-entries";
import { buildSections, type Section, type TestEntry } from "./snapshot-entries";

// Derives the categorized test-change sections for a snapshot. An authoritative snapshot's sections come from the
// analysis run's own findings (one per test it investigated); a legacy snapshot's come from the plan diff plus the
// tests the run created. Lives next to the two builders so the changes-page components can each fetch their own
// data instead of having sections drilled through props - the underlying queries are shared via react-query's
// cache, so calling this in several components is cheap.
export function useSnapshotSections(snapshotId: string): Section[] {
    const { data } = useFullSnapshotDetail(snapshotId);
    const { data: analysisJob } = useAnalysisJob(snapshotId);
    const { data: analysisReport } = useAnalysisReport(snapshotId, { jobStatus: analysisJob?.status });
    const { changes, createdTests } = data;
    const findings = analysisReport?.findings;
    const isAuthoritative = analysisJob != null;

    return useMemo(() => {
        // An authoritative run's suite changes are its findings. Until the report lands (running) or when the run
        // failed, there are no authoritative sections - and the raw plan diff must NOT be shown, since a failed
        // run's changes are discarded. The changes page renders a run-status empty state in that case.
        if (isAuthoritative) return findings != null ? buildAnalysisSections({ findings, changes }) : [];
        return buildSections({ changes, createdTests });
    }, [isAuthoritative, findings, changes, createdTests]);
}

// Resolves the single test entry addressed by `testId` (its `urlId`) within the snapshot.
export function useSnapshotEntry(snapshotId: string, testId: string): TestEntry | undefined {
    const sections = useSnapshotSections(snapshotId);
    return useMemo(() => sections.flatMap((s) => s.entries).find((e) => e.urlId === testId), [sections, testId]);
}
