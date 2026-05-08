import type { LanguageModel } from "@autonoma/ai";
import type { BugStatus, IssueCategory, IssueSeverity, Prisma } from "@autonoma/db";
import { db } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type {
    FailurePoint,
    GenerationVerdict,
    GenerationVerdictKind,
    ReplayVerdict,
    ReplayVerdictKind,
    ReviewEvidence,
    ReviewSeverity,
} from "@autonoma/types";
import { BugMatcher } from "./bug-matcher";
import { mapGenerationVerdictToIssueCategory, mapReplayVerdictToIssueCategory } from "./verdict-mapping";

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

interface LockedBugRow {
    id: string;
    title: string;
    description: string;
    status: BugStatus;
    severity: IssueSeverity;
}

export interface ResolveLinkContextParams {
    branchId: string;
    testCaseId: string;
}

export interface ReportFromGenerationVerdictParams {
    generationReviewId: string;
    verdict: GenerationVerdict;
    organizationId: string;
    skipBugCreation?: boolean;
    /** Resolved lazily so we don't query the snapshot/branch chain when we won't create a bug. */
    resolveLinkContext: () => Promise<ResolveLinkContextParams>;
}

export interface ReportFromRunVerdictParams {
    runReviewId: string;
    verdict: ReplayVerdict;
    organizationId: string;
    skipBugCreation?: boolean;
    resolveLinkContext: () => Promise<ResolveLinkContextParams>;
}

export interface PromoteIssueToBugParams {
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

/**
 * Writes Issues (and optionally links Bugs) in
 * response to reviewer verdicts and other ad-hoc bug-discovery events.
 *
 * Owns the full DB-write side of the legacy bug pipeline: verdict-to-category
 * mapping, the SELECT-FOR-UPDATE candidate locking, semantic dedup via
 * BugMatcher, and the severity-escalation / regression-detection rules.
 *
 */
export class IssueReporter {
    private readonly logger: Logger;

    constructor(private readonly bugMatcher: BugMatcher) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /** Convenience: build an IssueReporter and its BugMatcher from a model. */
    static fromModel(model: LanguageModel): IssueReporter {
        return new IssueReporter(new BugMatcher(model));
    }

    // ─── Verdict-driven entry points (post-review activities) ───────────────────

    async reportFromGenerationVerdict(params: ReportFromGenerationVerdictParams): Promise<void> {
        const category = mapGenerationVerdictToIssueCategory(params.verdict.verdict);
        if (category == null) {
            this.logger.info("Skipping issue creation for success verdict", {
                generationReviewId: params.generationReviewId,
            });
            return;
        }

        await this.persistIssue({
            ownerLink: { generationReviewId: params.generationReviewId },
            category,
            verdictKind: params.verdict.verdict,
            confidence: params.verdict.confidence,
            severity: params.verdict.severity,
            title: params.verdict.title,
            description: params.verdict.reasoning,
            organizationId: params.organizationId,
            skipBugCreation: params.skipBugCreation,
            resolveLinkContext: params.resolveLinkContext,
        });
    }

    async reportFromRunVerdict(params: ReportFromRunVerdictParams): Promise<void> {
        const category = mapReplayVerdictToIssueCategory(params.verdict.verdict);

        await this.persistIssue({
            ownerLink: { runReviewId: params.runReviewId },
            category,
            verdictKind: params.verdict.verdict,
            confidence: params.verdict.confidence,
            severity: params.verdict.severity,
            title: params.verdict.title,
            description: params.verdict.reasoning,
            organizationId: params.organizationId,
            skipBugCreation: params.skipBugCreation,
            resolveLinkContext: params.resolveLinkContext,
        });
    }

    // ─── Diffs callback: manual high-confidence bug report ──────────────────────

    async recordBugFromRunReview(tx: Prisma.TransactionClient, params: RecordBugFromRunReviewParams): Promise<void> {
        const issue = await this.upsertIssue(tx, {
            ownerLink: { runReviewId: params.runReviewId },
            category: params.category,
            confidence: params.confidence,
            severity: params.severity,
            title: params.title,
            description: params.description,
            organizationId: params.organizationId,
        });

        await this.promoteIssueToBug(tx, {
            issueId: issue.id,
            issueTitle: params.title,
            issueDescription: params.description,
            branchId: params.branchId,
            testCaseId: params.testCaseId,
            severity: params.severity,
            organizationId: params.organizationId,
        });
    }

    // ─── API "confirm as bug" UI flow ───────────────────────────────────────────

    /**
     * Promote an existing Issue to a Bug: find the matching Bug for this
     * Issue's branch/test-case (or create a new one), update its metadata
     * (lastSeenAt, severity escalation, regressed flip), and set
     * `issue.bugId` to point at it.
     */
    async promoteIssueToBug(tx: Prisma.TransactionClient, params: PromoteIssueToBugParams): Promise<void> {
        const { issueId, issueTitle, issueDescription, branchId, testCaseId, severity } = params;

        // Lock candidate Bug rows to prevent concurrent creation of duplicate Bugs.
        const candidates = await tx.$queryRaw<LockedBugRow[]>`
            SELECT id, title, description, status, severity
            FROM bug
            WHERE branch_id = ${branchId} AND test_case_id = ${testCaseId}
            FOR UPDATE
        `;

        this.logger.info("Promoting issue to bug - locked candidates", {
            candidateCount: candidates.length,
            branchId,
            testCaseId,
        });

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

    // ─── Internals ──────────────────────────────────────────────────────────────

    private async persistIssue(params: {
        ownerLink: { generationReviewId: string } | { runReviewId: string };
        category: "agent_error" | "application_bug";
        verdictKind: GenerationVerdictKind | ReplayVerdictKind;
        confidence: number;
        severity: ReviewSeverity;
        title: string;
        description: string;
        organizationId: string;
        skipBugCreation?: boolean;
        resolveLinkContext: () => Promise<ResolveLinkContextParams>;
    }): Promise<void> {
        const shouldPromoteToBug =
            params.skipBugCreation !== true &&
            params.category === "application_bug" &&
            params.confidence >= BUG_CONFIDENCE_THRESHOLD;

        const linkContext = shouldPromoteToBug ? await params.resolveLinkContext() : undefined;

        await db.$transaction(async (tx) => {
            const issue = await this.upsertIssue(tx, params);

            if (linkContext != null) {
                await this.promoteIssueToBug(tx, {
                    issueId: issue.id,
                    issueTitle: params.title,
                    issueDescription: params.description,
                    branchId: linkContext.branchId,
                    testCaseId: linkContext.testCaseId,
                    severity: params.severity,
                    organizationId: params.organizationId,
                });
            }
        });

        this.logger.info("Issue persisted from review verdict", {
            verdictKind: params.verdictKind,
            category: params.category,
            confidence: params.confidence,
            promotedToBug: linkContext != null,
        });
    }

    private async upsertIssue(
        tx: Prisma.TransactionClient,
        params: {
            ownerLink: { generationReviewId: string } | { runReviewId: string };
            category: "agent_error" | "application_bug";
            confidence: number;
            severity: ReviewSeverity;
            title: string;
            description: string;
            organizationId: string;
        },
    ): Promise<{ id: string }> {
        const where =
            "generationReviewId" in params.ownerLink
                ? { generationReviewId: params.ownerLink.generationReviewId }
                : { runReviewId: params.ownerLink.runReviewId };

        const baseData = {
            category: params.category,
            confidence: params.confidence,
            severity: params.severity,
            title: params.title,
            description: params.description,
        };

        return tx.issue.upsert({
            where,
            create: {
                ...baseData,
                organizationId: params.organizationId,
                ...params.ownerLink,
            },
            update: baseData,
            select: { id: true },
        });
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
            this.logger.warn(
                "Matched bug not found in locked candidates; skipping linking to avoid inconsistent state",
                { bugId, issueId },
            );
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

        this.logger.info("Linked issue to existing bug", {
            bugId,
            issueId,
            isRegression,
            severityEscalated: newSeverity !== bug.severity,
        });
    }

    private async createNewBug(tx: Prisma.TransactionClient, params: PromoteIssueToBugParams): Promise<void> {
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

        this.logger.info("Created new bug from issue", { bugId: bug.id, issueId: params.issueId });
    }
}

/**
 * Convenience for callers that want the failure-point text without null checks.
 */
export function failurePointDescription(failurePoint: FailurePoint | undefined): string | undefined {
    return failurePoint?.description;
}

/**
 * Stamp finalScreenshot/video S3 keys onto evidence items returned by the agent.
 */
export function enrichEvidenceWithKeys(
    evidence: ReviewEvidence[],
    extras: { finalScreenshotKey?: string; videoKey?: string },
): ReviewEvidence[] {
    return evidence.map((item) => {
        if (item.type === "screenshot" && extras.finalScreenshotKey != null) {
            return { ...item, s3Key: extras.finalScreenshotKey };
        }
        if (item.type === "video" && extras.videoKey != null) {
            return { ...item, s3Key: extras.videoKey };
        }
        return item;
    });
}
