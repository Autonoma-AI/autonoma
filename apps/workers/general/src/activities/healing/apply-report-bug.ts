import type { BugStatus, Prisma } from "@autonoma/db";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
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

        const bugId =
            input.matchedBugId != null
                ? await linkExistingBug(tx, input.matchedBugId, snapshot.branchId, input)
                : await createNewBug(tx, snapshot.branchId, snapshot.branch.applicationId, input);

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
                report: buildIssueReport(input),
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

async function linkExistingBug(
    tx: Prisma.TransactionClient,
    bugId: string,
    snapshotBranchId: string,
    input: ApplyReportBugInput,
): Promise<string> {
    const bug = await tx.bug.findUniqueOrThrow({
        where: { id: bugId },
        select: { status: true, severity: true, branchId: true },
    });

    // Invariant: a matched bug must live on the same branch as the detecting
    // snapshot. BugMatcher only ever proposes candidates from this branch, so a
    // mismatch means a cross-branch match slipped through - refuse to attach.
    if (bug.branchId !== snapshotBranchId) {
        throw new Error(
            `report_bug branch invariant violation: matched bug ${bugId} is on branch ${bug.branchId ?? "null"} but the detecting snapshot ${input.snapshotId} is on branch ${snapshotBranchId}`,
        );
    }

    const newStatus: BugStatus = bug.status === "resolved" ? "regressed" : bug.status;
    const newSeverity = pickHigherSeverity(bug.severity, input.severity);

    await tx.bug.update({
        where: { id: bugId },
        data: {
            lastSeenAt: new Date(),
            status: newStatus,
            severity: newSeverity,
            ...(newStatus === "regressed" ? { resolvedAt: null } : {}),
        },
    });

    await tx.bugTestCaseEvidence.upsert({
        where: { bugId_testCaseId: { bugId, testCaseId: input.testCaseId } },
        create: { bugId, testCaseId: input.testCaseId },
        update: { lastSeenAt: new Date() },
    });

    return bugId;
}

async function createNewBug(
    tx: Prisma.TransactionClient,
    branchId: string,
    applicationId: string,
    input: ApplyReportBugInput,
): Promise<string> {
    const bug = await tx.bug.create({
        data: {
            title: input.title,
            description: input.description,
            severity: input.severity,
            branchId,
            applicationId,
            organizationId: input.organizationId,
            evidence: { create: { testCaseId: input.testCaseId } },
        },
        select: { id: true },
    });
    return bug.id;
}

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;

function pickHigherSeverity<S extends keyof typeof SEVERITY_RANK>(a: S, b: S): S {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}
