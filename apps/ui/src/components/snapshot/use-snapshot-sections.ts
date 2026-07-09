import { FULL_SNAPSHOT_DETAIL, useSnapshotDetail } from "lib/query/branches.queries";
import { useMemo } from "react";
import { buildSections, type Section, type TestEntry } from "./snapshot-entries";

// Reads the full snapshot detail and derives the categorized test-change sections.
// Lives next to `buildSections` so the changes-page components can each fetch their
// own data instead of having sections drilled through props. The underlying query is
// shared via react-query's cache, so calling this in multiple components is cheap.
export function useSnapshotSections(snapshotId: string): Section[] {
    const { data } = useSnapshotDetail(snapshotId, FULL_SNAPSHOT_DETAIL);
    const { changes, diffsJob, createdTests } = data;
    return useMemo(
        () =>
            buildSections({
                changes,
                affectedTests: diffsJob.affectedTests,
                createdTests,
            }),
        [changes, diffsJob.affectedTests, createdTests],
    );
}

// Resolves the single test entry addressed by `testId` (its `urlId`) within the snapshot.
export function useSnapshotEntry(snapshotId: string, testId: string): TestEntry | undefined {
    const sections = useSnapshotSections(snapshotId);
    return useMemo(() => sections.flatMap((s) => s.entries).find((e) => e.urlId === testId), [sections, testId]);
}
