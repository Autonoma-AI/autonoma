import type { BugStatus, Prisma } from "@autonoma/db";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
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
        const bugId =
            input.matchedBugId != null
                ? await linkExistingBug(tx, input.matchedBugId, input)
                : await createNewBug(tx, input);

        await tx.issue.create({
            data: {
                ...input.reviewLink,
                kind: "application_bug",
                severity: input.severity,
                title: input.title,
                description: input.description,
                bugId,
                organizationId: input.organizationId,
            },
            select: { id: true },
        });
    });

    await markActionApplied(input.refinementActionId);
    logger.info("report_bug applied");
}

async function linkExistingBug(
    tx: Prisma.TransactionClient,
    bugId: string,
    input: ApplyReportBugInput,
): Promise<string> {
    const bug = await tx.bug.findUniqueOrThrow({
        where: { id: bugId },
        select: { status: true, severity: true },
    });

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

async function createNewBug(tx: Prisma.TransactionClient, input: ApplyReportBugInput): Promise<string> {
    const snapshot = await tx.branchSnapshot.findUniqueOrThrow({
        where: { id: input.snapshotId },
        select: { branch: { select: { applicationId: true } } },
    });

    const bug = await tx.bug.create({
        data: {
            title: input.title,
            description: input.description,
            severity: input.severity,
            applicationId: snapshot.branch.applicationId,
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
