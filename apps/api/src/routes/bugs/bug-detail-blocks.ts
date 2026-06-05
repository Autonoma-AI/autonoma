import type { PrismaClient } from "@autonoma/db";
import type { StorageProvider } from "@autonoma/storage";
import { buildLatestOccurrenceEvidence } from "./bug-detail-latest-occurrence";
import { buildOccurrences } from "./bug-detail-occurrences";
import { signIssuesEvidence } from "./bug-detail-signed-issues";
import type { BugIssueRow, BugLatestOccurrenceIssueRow } from "./bugs.service";

export async function buildBugDetailBlocks(
    db: PrismaClient,
    issues: BugIssueRow[],
    latestRunIssue: BugLatestOccurrenceIssueRow | null,
    storageProvider: StorageProvider,
) {
    const latestOccurrence = await buildLatestOccurrenceEvidence(db, latestRunIssue, storageProvider);
    const occurrences = buildOccurrences(issues, issues[0]?.id);

    return {
        latestOccurrence,
        occurrences,
        issues: await signIssuesEvidence(issues, storageProvider),
    };
}
