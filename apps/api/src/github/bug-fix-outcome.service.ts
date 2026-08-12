import { AnalysisStore } from "@autonoma/analysis";
import type { PostHogAnalytics } from "@autonoma/analytics";
import type { Prisma } from "@autonoma/db";
import { BugFixOutcomeKind, type PrismaClient, withAdvisoryLock } from "@autonoma/db";
import { BUG_FIX_OUTCOME_EVENT, MERGE_GATE_ANALYTICS_GROUP } from "@autonoma/github/check";
import { analysisIssueKindSchema, analysisIssueStatusSchema } from "@autonoma/types";
import { z } from "zod";
import { Service } from "../routes/service";
import type { BranchContributorService } from "./branch-contributor.service";

const BUG_KIND = analysisIssueKindSchema.enum.bug;
const RESOLVED = analysisIssueStatusSchema.enum.resolved;

/** The `pull_request.closed` payload fields the bug-fix-outcome job reads. */
const prClosedWebhookSchema = z.object({
    pull_request: z.object({
        number: z.number(),
        merged: z.boolean().optional(),
        head: z.object({ sha: z.string() }),
        merged_at: z.string().nullish(),
        merged_by: z.object({ login: z.string() }).nullish(),
    }),
    repository: z.object({ id: z.number(), full_name: z.string() }),
});

export interface RecordBugFixOutcomesParams {
    organizationId: string;
    repoFullName: string;
    githubRepositoryId: number;
    prNumber: number;
    headSha: string;
    merged: boolean;
    mergedByLogin?: string;
    mergedAt?: Date;
}

/** One flagged bug issue as the classifier reads it. */
interface BugIssue {
    id: string;
    status: string;
    severity: string;
    resolvedAt?: Date;
}

/** The terminal classification of a merged PR: the rows to persist and the events to emit once they commit. */
interface OutcomePlan {
    rows: Prisma.BugFixOutcomeCreateManyInput[];
    events: PlannedEvent[];
}

/** A PostHog event queued to fire only after its row is durably written. */
interface PlannedEvent {
    event: string;
    issueId: string;
    severity?: string;
    fixAuthorLogins?: string[];
}

/**
 * Stickiness measurement: when a PR merges, record - per client bug we flagged - whether the developer fixed it
 * before merging. This is the core "did it help?" signal.
 *
 * It reads persisted state only and never re-runs analysis: the Reporter already resolves branch-scoped
 * {@link BugIssue}s (`AnalysisIssue`) automatically each run, so at merge time the issue's `status` already says
 * whether the bug still reproduces. `resolved` -> fixed_before_merge, `open` -> merged_with_bug. A skipped PR (a
 * `SkipRecord` exists) records `skipped`; a PR the analysis never assessed records `unknown`. Skipped/unknown emit
 * NO PostHog event, so a bypass is never double-counted against a per-bug fixed/open signal.
 */
export class BugFixOutcomeService extends Service {
    private readonly analysisStore: AnalysisStore;

    constructor(
        private readonly db: PrismaClient,
        private readonly analytics: PostHogAnalytics,
        private readonly mergeGateEnabled: boolean,
        /** Optional: the per-developer attribution primitive. When present, each fix is attributed to the authors of the push that resolved it. */
        private readonly branchContributor?: BranchContributorService,
    ) {
        super();
        this.analysisStore = new AnalysisStore(db);
    }

    /** Webhook entry for `pull_request.closed`: parse then record the per-bug merge outcomes. */
    async recordFromWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = prClosedWebhookSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("Bug-fix outcome: could not parse PR closed payload", {
                organizationId,
                extra: { issues: parsed.error.issues },
            });
            return;
        }
        const pr = parsed.data.pull_request;
        try {
            await this.recordBugFixOutcomes({
                organizationId,
                repoFullName: parsed.data.repository.full_name,
                githubRepositoryId: parsed.data.repository.id,
                prNumber: pr.number,
                headSha: pr.head.sha,
                merged: pr.merged === true,
                mergedByLogin: pr.merged_by?.login,
                mergedAt: pr.merged_at != null ? new Date(pr.merged_at) : undefined,
            });
        } catch (err) {
            this.logger.warn("Bug-fix outcome: recording failed, swallowing (non-critical measurement)", {
                organizationId,
                extra: { repoFullName: parsed.data.repository.full_name, prNumber: pr.number },
                err,
            });
        }
    }

    /**
     * Classify and persist the per-bug outcome for a merged PR.
     */
    async recordBugFixOutcomes(params: RecordBugFixOutcomesParams): Promise<void> {
        this.logger.info("Bug-fix outcome: recordBugFixOutcomes", {
            organizationId: params.organizationId,
            extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, merged: params.merged },
        });

        if (!params.merged) return;
        if (!(await this.isEnabledForOrg(params.organizationId))) return;

        const branch = await this.resolveBranch(params);
        if (branch == null) return;
        const { applicationId, branchId } = branch;

        if (await this.hasOutcomes(branchId)) {
            this.logger.info("Bug-fix outcome: already recorded for branch, skipping", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, branchId },
            });
            return;
        }

        const plan = await this.classify(applicationId, branchId, params);
        if (plan.rows.length === 0) {
            this.logger.info("Bug-fix outcome: nothing to record", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
            });
            return;
        }

        const wrote = await this.persist(branchId, plan.rows);
        if (!wrote) {
            this.logger.info("Bug-fix outcome: a concurrent delivery recorded first, skipping", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, branchId },
            });
            return;
        }

        for (const planned of plan.events) {
            this.analytics.capture(
                params.organizationId,
                planned.event,
                {
                    organizationId: params.organizationId,
                    repoFullName: params.repoFullName,
                    prNumber: params.prNumber,
                    branchId,
                    issueId: planned.issueId,
                    severity: planned.severity,
                    mergedByLogin: params.mergedByLogin,
                    fixAuthorLogins: planned.fixAuthorLogins,
                },
                { [MERGE_GATE_ANALYTICS_GROUP]: params.organizationId },
            );
        }
        this.logger.info("Bug-fix outcome: recorded per-bug outcomes", {
            organizationId: params.organizationId,
            extra: {
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                rowCount: plan.rows.length,
                eventCount: plan.events.length,
            },
        });
    }

    /**
     * Decide the terminal outcome. Skip wins over everything; then an unassessed PR is a single `unknown` marker;
     * then a clean PR records nothing; otherwise one row per bug (resolved -> fixed_before_merge, open ->
     * merged_with_bug) with its matching event.
     */
    private async classify(
        applicationId: string,
        branchId: string,
        params: RecordBugFixOutcomesParams,
    ): Promise<OutcomePlan> {
        const [skip, bugIssues] = await Promise.all([this.findSkip(params), this.loadBugIssues(branchId)]);

        if (skip != null) {
            this.logger.info("Bug-fix outcome: PR was skipped, recording skipped (no events)", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, bugCount: bugIssues.length },
            });
            return { rows: this.skippedRows(branchId, bugIssues, params), events: [] };
        }

        if (!(await this.isAssessed(branchId, params.mergedAt))) {
            this.logger.info("Bug-fix outcome: no completed analysis before merge, recording unknown (no events)", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
            });
            return { rows: [this.unknownRow(branchId, params)], events: [] };
        }

        if (bugIssues.length === 0) {
            this.logger.info("Bug-fix outcome: clean PR, no bugs to record", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
            });
            return { rows: [], events: [] };
        }

        return await this.classifyBugs(applicationId, branchId, bugIssues, params);
    }

    /** One row + one event per bug; a fix additionally resolves its attributed authors. */
    private async classifyBugs(
        applicationId: string,
        branchId: string,
        bugIssues: BugIssue[],
        params: RecordBugFixOutcomesParams,
    ): Promise<OutcomePlan> {
        const classified = await Promise.all(
            bugIssues.map(async (issue) => {
                const isFixed = issue.status === RESOLVED;
                const outcome = isFixed ? BugFixOutcomeKind.fixed_before_merge : BugFixOutcomeKind.merged_with_bug;
                const fixAuthorLogins = isFixed
                    ? await this.attributeFix(applicationId, branchId, issue, params)
                    : undefined;
                const row: Prisma.BugFixOutcomeCreateManyInput = {
                    organizationId: params.organizationId,
                    repoFullName: params.repoFullName,
                    prNumber: params.prNumber,
                    branchId,
                    issueId: issue.id,
                    outcome,
                    severity: issue.severity,
                    mergedAt: params.mergedAt,
                    mergedByLogin: params.mergedByLogin,
                };
                const event: PlannedEvent = {
                    event: isFixed ? BUG_FIX_OUTCOME_EVENT.fixed : BUG_FIX_OUTCOME_EVENT.mergedOpen,
                    issueId: issue.id,
                    severity: issue.severity,
                    fixAuthorLogins,
                };
                return { row, event };
            }),
        );
        return {
            rows: classified.map((entry) => entry.row),
            events: classified.map((entry) => entry.event),
        };
    }

    /** One `skipped` row per flagged bug. */
    private skippedRows(
        branchId: string,
        bugIssues: BugIssue[],
        params: RecordBugFixOutcomesParams,
    ): Prisma.BugFixOutcomeCreateManyInput[] {
        return bugIssues.map((issue) => ({
            organizationId: params.organizationId,
            repoFullName: params.repoFullName,
            prNumber: params.prNumber,
            branchId,
            issueId: issue.id,
            outcome: BugFixOutcomeKind.skipped,
            severity: issue.severity,
            mergedAt: params.mergedAt,
            mergedByLogin: params.mergedByLogin,
        }));
    }

    /** A single branch-level `unknown` marker (no issueId): the analysis never assessed this PR. */
    private unknownRow(branchId: string, params: RecordBugFixOutcomesParams): Prisma.BugFixOutcomeCreateManyInput {
        return {
            organizationId: params.organizationId,
            repoFullName: params.repoFullName,
            prNumber: params.prNumber,
            branchId,
            outcome: BugFixOutcomeKind.unknown,
            mergedAt: params.mergedAt,
            mergedByLogin: params.mergedByLogin,
        };
    }

    /**
     * Write all of a branch's outcome rows in one statement, serialized per branch by an advisory lock so two concurrent deliveries can never both write.
     */
    private async persist(branchId: string, rows: Prisma.BugFixOutcomeCreateManyInput[]): Promise<boolean> {
        return withAdvisoryLock(this.db, `bug-fix-outcome:${branchId}`, async () => {
            if (await this.hasOutcomes(branchId)) return false;
            await this.db.bugFixOutcome.createMany({ data: rows });
            return true;
        });
    }

    private async hasOutcomes(branchId: string): Promise<boolean> {
        const existing = await this.db.bugFixOutcome.findFirst({ where: { branchId }, select: { id: true } });
        return existing != null;
    }

    private async findSkip(params: RecordBugFixOutcomesParams): Promise<{ id: string } | null> {
        return this.db.skipRecord.findFirst({
            where: { repoFullName: params.repoFullName, prNumber: params.prNumber, headSha: params.headSha },
            select: { id: true },
        });
    }

    /**
     * Fix-attribution hook: the logins of the authors who pushed the fix that resolved this bug.
     */
    private async attributeFix(
        applicationId: string,
        branchId: string,
        issue: BugIssue,
        params: RecordBugFixOutcomesParams,
    ): Promise<string[] | undefined> {
        if (this.branchContributor == null || issue.resolvedAt == null) return undefined;

        const snapshot = await this.db.branchSnapshot.findFirst({
            where: { branchId, investigationParent: { is: null }, createdAt: { lte: issue.resolvedAt } },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });
        if (snapshot == null) return undefined;

        try {
            const authors = await this.branchContributor.resolveFixingPushAuthors({
                organizationId: params.organizationId,
                applicationId,
                snapshotOrHeadSha: snapshot.id,
            });
            return authors.map((author) => author.login).filter((login): login is string => login != null);
        } catch (err) {
            this.logger.warn("Bug-fix outcome: fix attribution failed (non-critical)", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, issueId: issue.id },
                err,
            });
            return undefined;
        }
    }

    /** The branch's flagged client bugs - the only issue kind this job counts (environment/scenario are ignored). */
    private async loadBugIssues(branchId: string): Promise<BugIssue[]> {
        const issues = await this.analysisStore.forBranch(branchId).issues({ kind: BUG_KIND });
        return issues.map((issue) => ({
            id: issue.id,
            status: issue.status,
            severity: issue.severity,
            resolvedAt: issue.resolvedAt,
        }));
    }

    /**
     * Whether the analysis authoritatively assessed this PR: the branch's latest run BEFORE the merge (its most
     * recent non-twin snapshot created at or before `mergedAt`) produced an `AnalysisReport`, whose mere existence
     * means the Reporter ran to completion and reconciled the branch's issues.
     */
    private async isAssessed(branchId: string, mergedAt?: Date): Promise<boolean> {
        const createdBeforeMerge = mergedAt != null ? { lte: mergedAt } : undefined;
        const latest = await this.db.branchSnapshot.findFirst({
            where: { branchId, investigationParent: { is: null }, createdAt: createdBeforeMerge },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });
        if (latest == null) return false;
        return this.analysisStore.forAnalysis(latest.id).isSettled();
    }

    /** Resolve the merged PR's application + tracked branch; absent when the repo/PR is not one we track. */
    private async resolveBranch(
        params: RecordBugFixOutcomesParams,
    ): Promise<{ applicationId: string; branchId: string } | undefined> {
        const application = await this.db.application.findFirst({
            where: { organizationId: params.organizationId, githubRepositoryId: params.githubRepositoryId },
            select: { id: true },
        });
        if (application == null) {
            this.logger.warn("Bug-fix outcome: no application for merged PR, skipping", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
            });
            return undefined;
        }
        const tracked = await this.db.featureBranchInfo.findUnique({
            where: { applicationId_prNumber: { applicationId: application.id, prNumber: params.prNumber } },
            select: { branchId: true },
        });
        if (tracked == null) {
            this.logger.info("Bug-fix outcome: PR not tracked, skipping", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
            });
            return undefined;
        }
        return { applicationId: application.id, branchId: tracked.branchId };
    }

    /** Effective runtime gate: the global switch AND the org's opt-in (mergeGateEnabled AND analysisEnabled). */
    private async isEnabledForOrg(organizationId: string): Promise<boolean> {
        if (!this.mergeGateEnabled) return false;
        const settings = await this.db.organizationSettings.findUnique({
            where: { organizationId },
            select: { mergeGateEnabled: true, analysisEnabled: true },
        });
        return settings?.mergeGateEnabled === true && settings.analysisEnabled === true;
    }
}
