import type { Prisma } from "@autonoma/db";
import type { BugStatus, IssueCategory, IssueSeverity } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import type { BugMatcher } from "./bug-matcher";

export const BUG_CONFIDENCE_THRESHOLD = 70;

const SEVERITY_RANK: Record<IssueSeverity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
};

function higherSeverity(a: IssueSeverity, b: IssueSeverity): IssueSeverity {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export interface LinkIssueToBugParams {
    issueId: string;
    issueTitle: string;
    issueDescription: string;
    branchId: string;
    testCaseId: string;
    severity: IssueSeverity;
    organizationId: string;
}

export interface RecordBugFromRunReviewParams {
    runReviewId: string;
    title: string;
    description: string;
    severity: IssueSeverity;
    confidence: number;
    category: IssueCategory;
    branchId: string;
    testCaseId: string;
    organizationId: string;
}

interface LockedBugRow {
    id: string;
    title: string;
    description: string;
    status: BugStatus;
    severity: IssueSeverity;
}

export class BugLinker {
    constructor(private readonly bugMatcher: BugMatcher) {}

    async recordBugFromRunReview(tx: Prisma.TransactionClient, params: RecordBugFromRunReviewParams): Promise<void> {
        const issue = await tx.issue.create({
            data: {
                runReviewId: params.runReviewId,
                category: params.category,
                confidence: params.confidence,
                severity: params.severity,
                title: params.title,
                description: params.description,
                organizationId: params.organizationId,
            },
        });

        await this.linkIssueToBug(tx, {
            issueId: issue.id,
            issueTitle: params.title,
            issueDescription: params.description,
            branchId: params.branchId,
            testCaseId: params.testCaseId,
            severity: params.severity,
            organizationId: params.organizationId,
        });
    }

    async linkIssueToBug(tx: Prisma.TransactionClient, params: LinkIssueToBugParams): Promise<void> {
        const { issueId, issueTitle, issueDescription, branchId, testCaseId, severity } = params;

        // Lock candidate Bug rows to prevent concurrent creation of duplicate Bugs
        const candidates = await tx.$queryRaw<LockedBugRow[]>`
            SELECT id, title, description, status, severity
            FROM bug
            WHERE branch_id = ${branchId} AND test_case_id = ${testCaseId}
            FOR UPDATE
        `;

        logger.info("Bug linking - locked candidates", {
            candidateCount: candidates.length,
            branchId,
            testCaseId,
        });

        // Run semantic matching against locked candidates
        const match = await this.bugMatcher.findMatchingBug(
            { title: issueTitle, description: issueDescription },
            candidates,
        );

        if (match != null) {
            await this.linkToExistingBug(tx, match.bugId, issueId, severity, candidates);
        } else {
            await this.createNewBug(tx, params);
        }
    }

    private async linkToExistingBug(
        tx: Prisma.TransactionClient,
        bugId: string,
        issueId: string,
        issueSeverity: IssueSeverity,
        candidates: LockedBugRow[],
    ): Promise<void> {
        const bug = candidates.find((c) => c.id === bugId);
        if (bug == null) {
            logger.warn("Matched bug not found in locked candidates; skipping linking to avoid inconsistent state", {
                bugId,
                issueId,
            });
            return;
        }

        const newSeverity = higherSeverity(bug.severity, issueSeverity);
        const isRegression = bug.status === "resolved";

        await tx.bug.update({
            where: { id: bugId },
            data: {
                lastSeenAt: new Date(),
                severity: newSeverity,
                ...(isRegression ? { status: "regressed" as BugStatus, resolvedAt: null } : {}),
            },
        });

        await tx.issue.update({
            where: { id: issueId },
            data: { bugId },
        });

        logger.info("Linked issue to existing bug", {
            bugId,
            issueId,
            isRegression,
            severityEscalated: newSeverity !== bug.severity,
        });
    }

    private async createNewBug(tx: Prisma.TransactionClient, params: LinkIssueToBugParams): Promise<void> {
        const bug = await tx.bug.create({
            data: {
                title: params.issueTitle,
                description: params.issueDescription,
                severity: params.severity,
                branchId: params.branchId,
                testCaseId: params.testCaseId,
                organizationId: params.organizationId,
            },
        });

        await tx.issue.update({
            where: { id: params.issueId },
            data: { bugId: bug.id },
        });

        logger.info("Created new bug from issue", {
            bugId: bug.id,
            issueId: params.issueId,
        });
    }
}
