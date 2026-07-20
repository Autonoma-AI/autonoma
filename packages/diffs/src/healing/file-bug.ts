import type { BugStatus, IssueSeverity, Prisma } from "@autonoma/db";

/**
 * Link an Issue's occurrence to an existing Bug or create a new one, returning the bug id. The healing
 * `report_bug` action's per-branch bug write goes through this - one source of truth for the create/link
 * semantics (reopen a resolved match, bump severity, upsert evidence, enforce the branch invariant), paired with
 * the shared `BugMatcher` that produces the `matchedBugId`. The caller owns the enclosing `$transaction` and the
 * Issue row it attaches afterward; this only resolves the Bug + evidence. (The merged analysis pipeline does NOT
 * file Bug/Issue - it persists everything to `AnalysisFinding` - so it does not call this.)
 */
export interface ResolveOrCreateBugParams {
    tx: Prisma.TransactionClient;
    /** When set, link to this existing bug (from `BugMatcher.findMatch`); else create a new one. */
    matchedBugId?: string;
    /** The branch the detecting snapshot lives on - the bug's scope. */
    branchId: string;
    /** The application the branch belongs to (denormalized onto the bug for application-scoped reads). */
    applicationId: string;
    testCaseId: string;
    severity: IssueSeverity;
    organizationId: string;
    title: string;
    description: string;
    /** The detecting snapshot id, used only in the branch-invariant error message. */
    detectingSnapshotId: string;
}

export async function resolveOrCreateBug(params: ResolveOrCreateBugParams): Promise<string> {
    return params.matchedBugId != null ? linkExistingBug(params, params.matchedBugId) : createNewBug(params);
}

/**
 * Link the occurrence to an existing bug: reopen it if it was resolved (status -> regressed, resolvedAt cleared),
 * bump to the higher severity, and upsert the test-case evidence (firstSeenAt preserved, lastSeenAt = now).
 */
async function linkExistingBug(params: ResolveOrCreateBugParams, bugId: string): Promise<string> {
    const { tx, branchId, testCaseId, severity, detectingSnapshotId } = params;
    const bug = await tx.bug.findUniqueOrThrow({
        where: { id: bugId },
        select: { status: true, severity: true, branchId: true },
    });

    // Invariant: a matched bug must live on the same branch as the detecting snapshot. BugMatcher only ever
    // proposes candidates from this branch, so a mismatch means a cross-branch match slipped through - refuse.
    if (bug.branchId !== branchId) {
        throw new Error(
            `report_bug branch invariant violation: matched bug ${bugId} is on branch ${bug.branchId ?? "null"} but the detecting snapshot ${detectingSnapshotId} is on branch ${branchId}`,
        );
    }

    const newStatus: BugStatus = bug.status === "resolved" ? "regressed" : bug.status;
    const newSeverity = pickHigherSeverity(bug.severity, severity);

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
        where: { bugId_testCaseId: { bugId, testCaseId } },
        create: { bugId, testCaseId },
        update: { lastSeenAt: new Date() },
    });

    return bugId;
}

async function createNewBug(params: ResolveOrCreateBugParams): Promise<string> {
    const { tx, branchId, applicationId, testCaseId, severity, organizationId, title, description } = params;
    const bug = await tx.bug.create({
        data: {
            title,
            description,
            severity,
            branchId,
            applicationId,
            organizationId,
            evidence: { create: { testCaseId } },
        },
        select: { id: true },
    });
    return bug.id;
}

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;

function pickHigherSeverity<S extends keyof typeof SEVERITY_RANK>(a: S, b: S): S {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}
