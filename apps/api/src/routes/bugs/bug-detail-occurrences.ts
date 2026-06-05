import type { BugOccurrenceEntry } from "@autonoma/types";
import type { BugIssueRow } from "./bugs.service";

export function buildOccurrences(
    issues: BugIssueRow[],
    latestOccurrenceIssueId: string | undefined,
): BugOccurrenceEntry[] {
    return issues.map((issue) => {
        const run = issue.runReview?.run;
        const generation = issue.generationReview?.generation;
        const snapshot = run?.assignment.snapshot ?? generation?.snapshot;
        return {
            issueId: issue.id,
            source: run != null ? "run" : "generation",
            runId: run?.id,
            generationId: generation?.id,
            createdAt: issue.createdAt,
            isLatest: latestOccurrenceIssueId != null && issue.id === latestOccurrenceIssueId,
            snapshotId: snapshot?.id,
            sha: snapshot?.headSha ?? undefined,
            prNumber: snapshot?.branch.prInfo?.prNumber,
            branchName: snapshot?.branch.name,
        };
    });
}
