import type { Prisma, PrismaClient } from "@autonoma/db";
import { analysisCoverageOwner, analysisIssueKindSchema, compareAnalysisIssues } from "@autonoma/types";
import { type Issue, readIssues } from "./read-issues";

const BUG_KIND = analysisIssueKindSchema.enum.bug;

/**
 * The open, non-bug issues behind this run's client-owned coverage gaps, most actionable first - what the PR comment
 * asks the reader to fix. Loaded in full (each with its designated run and media) so the comment can card them the
 * same way it cards bugs.
 *
 * A gap is the reader's when its verdict is client-owned or undecided AND it is attributed to an open issue that is
 * not a bug (bugs get their own cards). An unattributed gap is ours and contributes nothing; a malformed issue kind
 * reads as unattributed, which is the safe direction.
 *
 * "Unattributed means ours" only holds because a RECURRING gap cannot go unattributed: the Reporter's third coverage
 * guarantee rejects a finish that leaves an open issue uncarried when a covering test hit the same fault again, and
 * carrying it forward re-attributes this run's finding. Weaken that guarantee and a live configuration gap starts
 * reading as our problem on its second run.
 *
 * Findings are scanned slug-ordered, so equal-severity issues hold that stable slug order in the returned list.
 */
export async function readClientOwnedGaps(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<Issue[]> {
    const rows = await db.analysisFinding.findMany({
        where: { reportSnapshotId: snapshotId, currentClassification: { isNot: null } },
        orderBy: { testCase: { slug: "asc" } },
        select: {
            currentClassification: { select: { category: true } },
            issue: { select: { id: true, resolvedAt: true, currentVersion: { select: { kind: true } } } },
        },
    });

    // Insertion order is the slug order above; a `Set` also de-dupes issues seen on more than one finding.
    const gapIssueIds = new Set<string>();
    for (const row of rows) {
        const category = row.currentClassification?.category;
        if (category == null) continue;
        const owner = analysisCoverageOwner(category);
        if (owner !== "client" && owner !== "undecided") continue;

        const issue = row.issue;
        // Open (unresolved) only, and never a bug - bugs are carded on their own. A malformed or absent kind reads
        // as unattributed (skipped), the safe direction.
        if (issue == null || issue.resolvedAt != null || issue.currentVersion == null) continue;
        const kind = analysisIssueKindSchema.safeParse(issue.currentVersion.kind);
        if (!kind.success || kind.data === BUG_KIND) continue;

        gapIssueIds.add(issue.id);
    }

    if (gapIssueIds.size === 0) return [];

    // `readIssues` ranks kind then severity, breaking ties by id; re-break equal-severity ties by the slug order
    // above so the reader's cards hold a stable, source-ordered sequence rather than an arbitrary id order.
    const orderedIds = [...gapIssueIds];
    const slugRank = new Map(orderedIds.map((id, index) => [id, index]));
    const issues = await readIssues(db, { id: { in: orderedIds } });
    return issues.sort((a, b) => compareAnalysisIssues(a, b) || (slugRank.get(a.id) ?? 0) - (slugRank.get(b.id) ?? 0));
}
