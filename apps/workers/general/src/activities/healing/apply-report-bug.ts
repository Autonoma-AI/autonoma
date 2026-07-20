import { db } from "@autonoma/db";
import { resolveOrCreateBug } from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { stripUnbackedNarrativeImages } from "@autonoma/types";
import type { IssueReport } from "@autonoma/workflow/activities";
import { markActionApplied } from "./mark-applied";
import type { ApplyReportBugInput } from "./types";

/**
 * Creates an Issue and links to or creates a Bug + evidence row, recording the
 * confirmed application bug the failure surfaced. The test case stays in the
 * suite and keeps running every snapshot, so a later app-side fix is observed
 * the next time the test passes; this action only records why it currently fails.
 *
 * - matchedBugId set: link the Issue to the existing Bug, upsert evidence
 *   (firstSeenAt preserved, lastSeenAt = now), flip Bug.status to "regressed"
 *   if it was previously resolved.
 * - matchedBugId unset: create a new Bug with one evidence row, link the Issue.
 */
export async function applyReportBug(input: ApplyReportBugInput): Promise<void> {
    const logger = rootLogger.child({
        name: "applyReportBug",
        snapshotId: input.snapshotId,
        testCaseId: input.testCaseId,
        matchedBugId: input.matchedBugId,
    });
    logger.info("Applying report_bug");

    // Fold the grounded suspectedCause into the authored report, then run the
    // apply-time validation gate: any narrative image whose src is not a
    // manifest-backed evidence token is stripped before it ever reaches the
    // database, so a persisted narrative can only reference genuinely-fetched
    // screenshots.
    const report = sanitizeReport(buildIssueReport(input), logger);

    await db.$transaction(async (tx) => {
        // The branch a bug is scoped to is the branch of the snapshot it was detected
        // on (the investigation twin's branch is the feature branch, so this holds for
        // twin-detected bugs too). Resolved once and shared by both write paths so the
        // "Issue's snapshot branch == Bug.branchId" invariant is enforced from a single
        // source of truth.
        const snapshot = await tx.branchSnapshot.findUniqueOrThrow({
            where: { id: input.snapshotId },
            select: { branchId: true, branch: { select: { applicationId: true } } },
        });

        const bugId = await resolveOrCreateBug({
            tx,
            matchedBugId: input.matchedBugId,
            branchId: snapshot.branchId,
            applicationId: snapshot.branch.applicationId,
            testCaseId: input.testCaseId,
            severity: input.severity,
            organizationId: input.organizationId,
            title: input.title,
            description: input.description,
            detectingSnapshotId: input.snapshotId,
        });

        await tx.issue.create({
            data: {
                ...input.reviewLink,
                kind: "application_bug",
                severity: input.severity,
                title: input.title,
                description: input.description,
                // The evidence-grounded, customer-facing report the bug page renders
                // (Expected/Actual + narrative + hedged suspected cause). Undefined
                // leaves the column null for occurrences whose action carried no report.
                report,
                bugId,
                organizationId: input.organizationId,
            },
            select: { id: true },
        });
    });

    await markActionApplied(input.refinementActionId);
    logger.info("report_bug applied");
}

/**
 * The persisted report is the healing-authored text core plus the grounded
 * `suspectedCause` the same action carried. The cause is folded in here rather
 * than authored inside the report so it stays the code the agent actually read
 * for gating, captured once instead of duplicated. It has no home without a
 * report (the section renders below the proven case), so a bare cause with no
 * report is dropped.
 */
function buildIssueReport(input: ApplyReportBugInput): IssueReport | undefined {
    if (input.report == null) return undefined;
    if (input.suspectedCause == null) return input.report;
    return { ...input.report, suspectedCause: input.suspectedCause };
}

/**
 * Strip every narrative image whose src is not a manifest-backed evidence token:
 * unbacked `evidence:` tokens, but also raw storage paths or URLs the agent
 * fabricated instead of using a minted token. The manifest is built server-side
 * from the agent's real fetches, so this is the last gate that keeps a persisted
 * narrative from referencing a screenshot the agent never pulled - anything else
 * would sit in stored markdown as an unresolvable (or worse, resolvable-by-luck)
 * image src.
 */
function sanitizeReport(report: IssueReport | undefined, logger: Logger): IssueReport | undefined {
    if (report == null) return undefined;

    const backedAssetIds = new Set((report.evidenceManifest ?? []).map((asset) => asset.assetId));
    const { markdown, strippedSrcs } = stripUnbackedNarrativeImages(report.narrativeMarkdown, backedAssetIds);
    if (strippedSrcs.length === 0) return report;

    logger.warn("Stripped unbacked narrative images from bug report before persisting", {
        extra: { strippedSrcs },
    });
    return { ...report, narrativeMarkdown: markdown };
}
