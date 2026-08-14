import type { Prisma, PrismaClient } from "@autonoma/db";
import {
    type AnalysisIssueKind,
    type AnalysisIssueSeverity,
    analysisCoverageOwner,
    analysisIssueKindSchema,
    compareAnalysisIssues,
} from "@autonoma/types";
import { parseIssueEnums } from "../issue-enums";

const BUG_KIND = analysisIssueKindSchema.enum.bug;

/** A client-owned coverage gap, addressed by the open issue the Reporter attributed it to. */
export interface ClientOwnedGap {
    issueId: string;
    title: string;
}

/**
 * The open, non-bug issues behind this run's client-owned coverage gaps, most actionable first - what the PR comment
 * asks the reader to fix.
 *
 * A gap is the reader's when its verdict is client-owned or undecided AND it is attributed to an open issue that is
 * not a bug (bugs get their own cards). An unattributed gap is ours and contributes nothing; a malformed issue kind
 * reads as unattributed, which is the safe direction. Selects only the category and the attributed issue's header -
 * never the finding's run trace or evidence blobs.
 *
 * Findings are read slug-ordered and the sort is stable, so equal-severity issues hold that slug order.
 */
export async function readClientOwnedGaps(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<ClientOwnedGap[]> {
    const rows = await db.analysisFinding.findMany({
        where: { reportSnapshotId: snapshotId, currentClassification: { isNot: null } },
        orderBy: { testCase: { slug: "asc" } },
        select: {
            currentClassification: { select: { category: true } },
            issue: {
                select: {
                    id: true,
                    resolvedAt: true,
                    currentVersion: { select: { title: true, kind: true, severity: true } },
                },
            },
        },
    });

    const byIssueId = new Map<
        string,
        { id: string; title: string; kind: AnalysisIssueKind; severity: AnalysisIssueSeverity }
    >();
    for (const row of rows) {
        const category = row.currentClassification?.category;
        if (category == null) continue;
        const owner = analysisCoverageOwner(category);
        if (owner !== "client" && owner !== "undecided") continue;

        const issue = row.issue;
        // Open (unresolved) only, and never a bug - bugs are carded on their own.
        if (issue == null || issue.resolvedAt != null || issue.currentVersion == null) continue;
        const version = issue.currentVersion;
        const enums = parseIssueEnums({ id: issue.id, kind: version.kind, severity: version.severity });
        if (enums == null || enums.kind === BUG_KIND) continue;

        byIssueId.set(issue.id, { id: issue.id, title: version.title, kind: enums.kind, severity: enums.severity });
    }

    return [...byIssueId.values()]
        .sort((a, b) => compareAnalysisIssues(a, b))
        .map((issue) => ({ issueId: issue.id, title: issue.title }));
}
