import type { PostHogAnalytics } from "@autonoma/analytics";
import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import type { BranchProtectionResult, GitHubApp, GitHubInstallationClient } from "@autonoma/github";
import {
    createGitHubCheckRunStore,
    MERGE_GATE_ANALYTICS_GROUP,
    MERGE_GATE_CHECK_NAME,
    MERGE_GATE_EVENT,
    MERGE_GATE_RULESET_NAME,
    MERGE_GATE_SKIP_COMMENT_MARKER,
    parseSkipCommand,
} from "@autonoma/github/check";
import { payloadBuilder, renderMarkdown } from "@autonoma/github/comment";
import { type Logger, logger } from "@autonoma/logger";
import { ANALYSIS_VERDICT } from "@autonoma/types";
import { z } from "zod";
import type { FalsePositiveCandidateService } from "./false-positive-candidate.service";
import type { MergeGateSlackNotifier } from "./merge-gate-slack-notifier";

const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

/**
 * PROVISIONAL, case-insensitive phrase heuristic for "this skip reason claims the finding was a false positive".
 * It is a placeholder a classifier can replace later.
 */
const FALSE_POSITIVE_REASON_PHRASES = [
    "false positive",
    "false-positive",
    "not a bug",
    "isn't a bug",
    "no es un bug",
    "falso positivo",
    "es un fp",
];

function reasonIndicatesFalsePositive(reason: string): boolean {
    const normalized = reason.toLowerCase();
    return FALSE_POSITIVE_REASON_PHRASES.some((phrase) => normalized.includes(phrase));
}

/** Collapse a developer's free-text reason to a single clean line for display. */
function formatReason(reason: string): string {
    return reason.replace(/\s+/g, " ").trim();
}

/** The `Autonoma` check summary shown after a skip, on the check's own detail page. The reason is pre-formatted. */
function buildSkipCheckSummary(actorLogin: string, openBugCount: number, reason: string): string {
    return `@${actorLogin} skipped this check with ${openBugCount} bug(s) open. Reason: ${reason}.`;
}

/** PR payload fields the gate reads on open/synchronize/reopen/ready. */
const prOpenWebhookSchema = z.object({
    pull_request: z.object({ number: z.number(), head: z.object({ sha: z.string() }) }),
    repository: z.object({ id: z.number(), full_name: z.string() }),
});

/** PR payload fields the gate reads on close. */
const prClosedWebhookSchema = z.object({
    pull_request: z.object({
        number: z.number(),
        merged: z.boolean().optional(),
        merge_commit_sha: z.string().nullish(),
        merged_at: z.string().nullish(),
        merged_by: z.object({ login: z.string() }).nullish(),
        head: z.object({ sha: z.string() }),
    }),
    repository: z.object({ id: z.number(), full_name: z.string() }),
});

/**
 * `issue_comment` payload fields the skip command reads.
 */
const issueCommentWebhookSchema = z.object({
    issue: z.object({
        number: z.number(),
        pull_request: z.object({}).passthrough().nullish(),
    }),
    comment: z.object({ body: z.string(), user: z.object({ login: z.string() }) }),
    repository: z.object({ id: z.number(), full_name: z.string() }),
});

export interface PostPendingParams {
    organizationId: string;
    repoFullName: string;
    githubRepositoryId: number;
    prNumber: number;
    headSha: string;
}

export interface ApplySkipParams {
    organizationId: string;
    repoFullName: string;
    githubRepositoryId: number;
    prNumber: number;
    actorLogin: string;
    /**
     * The free-text reason from the `/autonoma-skip <reason>` comment. Required and non-empty: a skip with no
     * reason is rejected before it reaches here (the reason is the public-disclosure nudge, so it is mandatory).
     */
    reason: string;
}

export interface RecordMergeParams {
    organizationId: string;
    repoFullName: string;
    githubRepositoryId: number;
    prNumber: number;
    headSha: string;
    merged: boolean;
    mergeCommitSha?: string;
    mergedByLogin?: string;
    mergedAt?: Date;
}

export interface MergeGateRepoProtection {
    repoFullName: string;
    result: BranchProtectionResult;
}

export interface MergeGateEnableResult {
    enabled: boolean;
    /** Per-repo outcome of registering the required `Autonoma` check. */
    protections: MergeGateRepoProtection[];
}

/**
 * Owns the merge-gate lifecycle on the API side: posting the pending `Autonoma` check when a PR opens, honoring the Skip button,
 * persisting merge facts and detecting a "merged around us" bypass on close, and the per-org enable/disable that registers/de-registers
 * branch protection.
 */
export class MergeGateService {
    private readonly logger: Logger;
    private readonly checkRuns: ReturnType<typeof createGitHubCheckRunStore>;

    constructor(
        private readonly db: PrismaClient,
        private readonly githubApp: GitHubApp,
        private readonly mergeGateEnabled: boolean,
        private readonly analytics: PostHogAnalytics,
        private readonly falsePositiveCandidates: FalsePositiveCandidateService,
        private readonly slackNotifier?: MergeGateSlackNotifier,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
        this.checkRuns = createGitHubCheckRunStore(db);
    }

    /** Webhook entry for `pull_request.opened/synchronize/reopened/ready_for_review`: parse then post the pending check. */
    async postPendingFromWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = prOpenWebhookSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("Merge gate: could not parse PR open payload", {
                organizationId,
                extra: { issues: parsed.error.issues },
            });
            return;
        }
        await this.postPending({
            organizationId,
            repoFullName: parsed.data.repository.full_name,
            githubRepositoryId: parsed.data.repository.id,
            prNumber: parsed.data.pull_request.number,
            headSha: parsed.data.pull_request.head.sha,
        });
    }

    /**
     * Post (once per head SHA) the pending `Autonoma` check when a PR opens or is synchronized.
     */
    async postPending(params: PostPendingParams): Promise<void> {
        this.logger.info("Merge gate: postPending", {
            organizationId: params.organizationId,
            extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
        });
        if (!(await this.isEnabledForOrg(params.organizationId))) {
            this.logger.info("Merge gate: postPending skipped (gate not enabled for org)", {
                organizationId: params.organizationId,
            });
            return;
        }

        const client = await this.getInstallationClient(params.organizationId);
        await this.checkRuns.runExclusive(params.repoFullName, params.headSha, async () => {
            const existing = await this.checkRuns.getByHead(params.repoFullName, params.headSha);
            if (existing != null) {
                this.logger.info("Merge gate: pending check already posted for head", {
                    organizationId: params.organizationId,
                    extra: { repoFullName: params.repoFullName, headSha: params.headSha },
                });
                return;
            }

            const checkRunId = await client.createCheckRun({
                repoFullName: params.repoFullName,
                headSha: params.headSha,
                name: MERGE_GATE_CHECK_NAME,
                status: "in_progress",
                title: "Analyzing this PR",
                summary: "Autonoma is analyzing this PR for client bugs.",
            });
            await this.checkRuns.upsert({
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                headSha: params.headSha,
                checkRunId,
            });
            this.logger.info("Merge gate: pending check posted", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, checkRunId },
            });
        });
    }

    /**
     * Webhook entry for `issue_comment.created`: a developer skips a blocking check by commenting
     * `/autonoma-skip <reason>` on the PR.
     */
    async applySkipFromCommentWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = issueCommentWebhookSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("Merge gate: could not parse issue_comment payload", {
                organizationId,
                extra: { issues: parsed.error.issues },
            });
            return;
        }
        if (parsed.data.issue.pull_request == null) return; // a plain issue comment, not a PR comment
        const command = parseSkipCommand(parsed.data.comment.body);
        if (command == null) return; // any other PR comment

        const repoFullName = parsed.data.repository.full_name;
        const prNumber = parsed.data.issue.number;
        const actorLogin = parsed.data.comment.user.login;

        // Stay silent on orgs that have not opted into the gate - never comment on a non-gated repo.
        if (!(await this.isEnabledForOrg(organizationId))) {
            this.logger.info("Merge gate: ignoring /autonoma-skip (gate not enabled for org)", { organizationId });
            return;
        }

        // A reason is mandatory - it is the public-disclosure nudge and the raw material for the customer
        // conversation. Reject a bare or whitespace-only command with a reply asking for one, and do not skip.
        const reason = command.reason != null ? formatReason(command.reason) : "";
        if (reason === "") {
            this.logger.info("Merge gate: /autonoma-skip rejected - no reason provided", {
                organizationId,
                extra: { repoFullName, prNumber, actorLogin },
            });
            const client = await this.getInstallationClient(organizationId);
            await this.postReasonRequiredReply(client, repoFullName, prNumber);
            return;
        }

        await this.applySkip({
            organizationId,
            repoFullName,
            githubRepositoryId: parsed.data.repository.id,
            prNumber,
            actorLogin,
            reason,
        });
    }

    /**
     * Honor a `/autonoma-skip` comment: resolve the PR's current check, snapshot the open bugs at skip time into a
     * SkipRecord (with the reason), flip the check to `neutral` (unblocks), post the attribution comment, and emit
     * the skip signal.
     */
    async applySkip(params: ApplySkipParams): Promise<void> {
        this.logger.info("Merge gate: applySkip", {
            organizationId: params.organizationId,
            extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, actorLogin: params.actorLogin },
        });

        if (!(await this.isEnabledForOrg(params.organizationId))) {
            this.logger.info("Merge gate: applySkip skipped (gate not enabled for org)", {
                organizationId: params.organizationId,
            });
            return;
        }

        const check = await this.checkRuns.getLatestByPr(params.repoFullName, params.prNumber);
        if (check == null || check.conclusion !== "failure") {
            this.logger.info("Merge gate: nothing to skip (no blocking check on the PR's current head)", {
                organizationId: params.organizationId,
                extra: {
                    repoFullName: params.repoFullName,
                    prNumber: params.prNumber,
                    conclusion: check?.conclusion,
                },
            });
            return;
        }

        const client = await this.getInstallationClient(params.organizationId);
        await this.checkRuns.runExclusive(params.repoFullName, check.headSha, async () => {
            const openBugs = await this.snapshotOpenBugs({
                organizationId: params.organizationId,
                githubRepositoryId: params.githubRepositoryId,
                repoFullName: params.repoFullName,
                headSha: check.headSha,
            });

            await client.updateCheckRun({
                repoFullName: params.repoFullName,
                checkRunId: check.checkRunId,
                status: "completed",
                conclusion: "neutral",
                title: `Skipped by @${params.actorLogin}`,
                summary: buildSkipCheckSummary(params.actorLogin, openBugs.findingIds.length, params.reason),
            });
            await this.checkRuns.setConclusion(params.repoFullName, check.headSha, "neutral").catch((err) => {
                this.logger.warn("Merge gate: could not persist skip conclusion (no check row for head)", {
                    organizationId: params.organizationId,
                    extra: { repoFullName: params.repoFullName, headSha: check.headSha },
                    err,
                });
            });

            const alreadyRecorded = await this.db.skipRecord.findFirst({
                where: { repoFullName: params.repoFullName, headSha: check.headSha },
                select: { id: true },
            });
            if (alreadyRecorded != null) {
                this.logger.info("Merge gate: skip already recorded for head; re-flipped check only", {
                    organizationId: params.organizationId,
                    extra: { repoFullName: params.repoFullName, headSha: check.headSha },
                });
                return;
            }

            const skipRecord = await this.db.skipRecord.create({
                data: {
                    organizationId: params.organizationId,
                    repoFullName: params.repoFullName,
                    prNumber: params.prNumber,
                    headSha: check.headSha,
                    snapshotId: openBugs.snapshotId,
                    actorLogin: params.actorLogin,
                    openBugCount: openBugs.findingIds.length,
                    openFindingIds: openBugs.findingIds,
                    reason: params.reason,
                },
            });

            const skipCommentId = await this.postSkipNote({
                client,
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                actorLogin: params.actorLogin,
                openBugCount: openBugs.findingIds.length,
                reason: params.reason,
            });
            if (skipCommentId != null) {
                await this.db.skipRecord
                    .update({ where: { id: skipRecord.id }, data: { skipCommentId } })
                    .catch((err) => {
                        this.logger.error("Merge gate: could not persist skip comment id", {
                            organizationId: params.organizationId,
                            extra: { repoFullName: params.repoFullName, skipRecordId: skipRecord.id },
                            err,
                        });
                    });
            }

            this.analytics.capture(
                params.organizationId,
                MERGE_GATE_EVENT.skipped,
                {
                    organizationId: params.organizationId,
                    repoFullName: params.repoFullName,
                    prNumber: params.prNumber,
                    headSha: check.headSha,
                    actorLogin: params.actorLogin,
                    openBugCount: openBugs.findingIds.length,
                    snapshotId: openBugs.snapshotId,
                },
                { [MERGE_GATE_ANALYTICS_GROUP]: params.organizationId },
            );

            await this.slackNotifier?.notifySkip({
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                actorLogin: params.actorLogin,
                openBugCount: openBugs.findingIds.length,
                reason: params.reason,
            });

            await this.captureSkipReasonFalsePositives({
                organizationId: params.organizationId,
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                actorLogin: params.actorLogin,
                reason: params.reason,
                openBugs,
            });

            this.logger.warn("Merge gate: check skipped", {
                organizationId: params.organizationId,
                extra: {
                    repoFullName: params.repoFullName,
                    prNumber: params.prNumber,
                    actorLogin: params.actorLogin,
                    openBugCount: openBugs.findingIds.length,
                },
            });
        });
    }

    /**
     * Secondary false-positive channel: when a developer's `/autonoma-skip` reason claims the finding was a false
     * positive, mirror the skip's open findings into the FP-candidate store. Tracking only - it does NOT change the
     * skip's unblock/record/alert behavior, and nothing reads these rows. Not every skip is an FP, so a non-FP
     * reason (e.g. "urgent hotfix") records nothing.
     */
    private async captureSkipReasonFalsePositives(params: {
        organizationId: string;
        repoFullName: string;
        prNumber: number;
        actorLogin: string;
        reason: string;
        openBugs: { snapshotId?: string; findingSlugs: string[] };
    }): Promise<void> {
        if (!reasonIndicatesFalsePositive(params.reason)) return;
        if (params.openBugs.snapshotId == null || params.openBugs.findingSlugs.length === 0) return;

        try {
            const count = await this.falsePositiveCandidates.recordFromSkipReason({
                organizationId: params.organizationId,
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                snapshotId: params.openBugs.snapshotId,
                findingKeys: params.openBugs.findingSlugs,
                reportedBy: params.actorLogin,
                reason: params.reason,
            });
            this.logger.info("Merge gate: skip reason flagged as a false positive; recorded FP candidates", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, count },
            });
        } catch (err) {
            this.logger.warn("Merge gate: failed to record skip-reason FP candidates", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
                err,
            });
        }
    }

    /** Webhook entry for `pull_request.closed`: parse then persist merge facts + detect a bypass. */
    async recordMergeFromWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = prClosedWebhookSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("Merge gate: could not parse PR closed payload", {
                organizationId,
                extra: { issues: parsed.error.issues },
            });
            return;
        }
        const pr = parsed.data.pull_request;
        await this.recordMergeAndDetectBypass({
            organizationId,
            repoFullName: parsed.data.repository.full_name,
            githubRepositoryId: parsed.data.repository.id,
            prNumber: pr.number,
            headSha: pr.head.sha,
            merged: pr.merged === true,
            mergeCommitSha: pr.merge_commit_sha ?? undefined,
            mergedByLogin: pr.merged_by?.login,
            mergedAt: pr.merged_at != null ? new Date(pr.merged_at) : undefined,
        });
    }

    /**
     * On `pull_request.closed` for a merged PR of a gate-enabled org: persist the merge facts, then detect a bypass.
     */
    async recordMergeAndDetectBypass(params: RecordMergeParams): Promise<void> {
        this.logger.info("Merge gate: recordMergeAndDetectBypass", {
            organizationId: params.organizationId,
            extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, merged: params.merged },
        });

        if (!params.merged) return;
        if (!(await this.isEnabledForOrg(params.organizationId))) return;

        await this.persistMergeFacts(params);

        const check = await this.checkRuns.getByHead(params.repoFullName, params.headSha);
        if (check?.conclusion !== "failure") return;

        const skip = await this.db.skipRecord.findFirst({
            where: { repoFullName: params.repoFullName, headSha: params.headSha },
            select: { id: true },
        });
        if (skip != null) return;

        this.analytics.capture(
            params.organizationId,
            MERGE_GATE_EVENT.bypassed,
            {
                prNumber: params.prNumber,
                repoFullName: params.repoFullName,
                mergedByLogin: params.mergedByLogin,
                mergeCommitSha: params.mergeCommitSha,
            },
            { [MERGE_GATE_ANALYTICS_GROUP]: params.organizationId },
        );
        this.logger.warn("Merge gate: PR merged around a blocking check (bypass)", {
            organizationId: params.organizationId,
            extra: {
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                mergedByLogin: params.mergedByLogin,
            },
        });
    }

    /**
     * Enable the gate for an org: requires `analysisEnabled` (the gate reads the authoritative verdict), flips
     * `mergeGateEnabled`, and registers `Autonoma` as a required status check on each linked repo's default branch.
     */
    async enableForOrg(organizationId: string): Promise<MergeGateEnableResult> {
        this.logger.info("Merge gate: enableForOrg", { organizationId });

        await this.db.$transaction(async (tx) => {
            const settings = await tx.organizationSettings.findUnique({
                where: { organizationId },
                select: { analysisEnabled: true },
            });
            if (settings?.analysisEnabled !== true) {
                throw new BadRequestError(
                    "Merge gate requires analysisEnabled: the gate reads the authoritative analysis verdict, " +
                        "which only orgs on the analysis pipeline produce. Enable analysis for this org first.",
                );
            }
            await tx.organizationSettings.update({
                where: { organizationId },
                data: { mergeGateEnabled: true },
            });
        });

        const protections = await this.applyBranchProtection(organizationId, "register");
        this.logger.info("Merge gate: enabled for org", {
            organizationId,
            extra: { protectedRepos: protections.length },
        });
        return { enabled: true, protections };
    }

    /** Disable the gate for an org: flips `mergeGateEnabled` off and de-registers the required context so it unblocks. */
    async disableForOrg(organizationId: string): Promise<MergeGateEnableResult> {
        this.logger.info("Merge gate: disableForOrg", { organizationId });

        await this.db.organizationSettings.updateMany({
            where: { organizationId },
            data: { mergeGateEnabled: false },
        });

        const protections = await this.applyBranchProtection(organizationId, "deregister");
        this.logger.info("Merge gate: disabled for org", { organizationId });
        return { enabled: false, protections };
    }

    /** Effective runtime gate: the global switch AND the org's opt-in. */
    private async isEnabledForOrg(organizationId: string): Promise<boolean> {
        if (!this.mergeGateEnabled) return false;
        const settings = await this.db.organizationSettings.findUnique({
            where: { organizationId },
            select: { mergeGateEnabled: true, analysisEnabled: true },
        });
        return settings?.mergeGateEnabled === true && settings.analysisEnabled === true;
    }

    /**
     * Register or de-register the `Autonoma` required-status-check ruleset on every linked repo, covering ALL
     * branches (not just the default one) so a PR into any base branch is gated.
     */
    private async applyBranchProtection(
        organizationId: string,
        action: "register" | "deregister",
    ): Promise<MergeGateRepoProtection[]> {
        const applications = await this.db.application.findMany({
            where: { organizationId, githubRepositoryId: { not: null } },
            select: { githubRepositoryId: true },
        });
        const repoIds = applications
            .map((application) => application.githubRepositoryId)
            .filter((id): id is number => id != null);
        if (repoIds.length === 0) return [];

        const client = await this.getInstallationClient(organizationId);
        return Promise.all(
            repoIds.map(async (repoId): Promise<MergeGateRepoProtection> => {
                const repo = await client.getRepository(repoId);
                const result =
                    action === "register"
                        ? await client.requireStatusCheckOnAllBranches({
                              repoFullName: repo.fullName,
                              contextName: MERGE_GATE_CHECK_NAME,
                              rulesetName: MERGE_GATE_RULESET_NAME,
                          })
                        : await client.removeRequiredStatusCheckRuleset({
                              repoFullName: repo.fullName,
                              rulesetName: MERGE_GATE_RULESET_NAME,
                          });
                return { repoFullName: repo.fullName, result };
            }),
        );
    }

    /**
     * Reply to a `/autonoma-skip` comment that carried no reason, asking for one. Best-effort: a failure is logged,
     * never thrown - the developer can just comment again.
     */
    private async postReasonRequiredReply(
        client: GitHubInstallationClient,
        repoFullName: string,
        prNumber: number,
    ): Promise<void> {
        const body =
            "To skip the Autonoma check, please include a reason: `/autonoma-skip <why>`. " +
            "It will be posted publicly on this PR.";
        try {
            await client.postComment(repoFullName, prNumber, body);
            this.logger.info("Merge gate: posted reason-required reply", { extra: { repoFullName, prNumber } });
        } catch (err) {
            this.logger.warn("Merge gate: failed to post reason-required reply", {
                extra: { repoFullName, prNumber },
                err,
            });
        }
    }

    /**
     * Post a standalone PR comment attributing the skip, so the bypass is visible in the PR conversation.
     */
    private async postSkipNote(params: {
        client: GitHubInstallationClient;
        repoFullName: string;
        prNumber: number;
        actorLogin: string;
        openBugCount: number;
        reason: string;
    }): Promise<string | undefined> {
        const bugCount = params.openBugCount;
        const bugsClause = `${bugCount} ${bugCount === 1 ? "bug was" : "bugs were"} open`;
        const headline = `@${params.actorLogin} skipped the Autonoma check because ${params.reason} (${bugsClause}).`;
        const body = renderMarkdown(
            payloadBuilder({ state: "skipped", prNumber: params.prNumber, message: headline }),
            {
                marker: MERGE_GATE_SKIP_COMMENT_MARKER,
            },
        );
        try {
            const commentId = await params.client.postComment(params.repoFullName, params.prNumber, body);
            this.logger.info("Merge gate: posted skip note comment", {
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, actorLogin: params.actorLogin },
            });
            return commentId;
        } catch (err) {
            this.logger.warn("Merge gate: failed to post skip note comment", {
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
                err,
            });
            return undefined;
        }
    }

    /** Read the latest snapshot at this head's open `client_bug` findings - the skip's captured signal. */
    private async snapshotOpenBugs(params: {
        organizationId: string;
        githubRepositoryId: number;
        repoFullName: string;
        headSha: string;
    }): Promise<{ snapshotId?: string; findingIds: string[]; findingSlugs: string[] }> {
        const { organizationId, githubRepositoryId, repoFullName, headSha } = params;
        const snapshot = await this.db.branchSnapshot.findFirst({
            where: { headSha, branch: { application: { organizationId, githubRepositoryId } } },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });
        if (snapshot == null) {
            this.logger.warn("Merge gate: no snapshot found for skipped head", {
                organizationId,
                extra: { repoFullName, headSha },
            });
            return { findingIds: [], findingSlugs: [] };
        }
        // Findings are keyed to the AnalysisJob; read them directly by the snapshot's PK. The bug set is the one
        // the run STANDS BEHIND - a self-heal iteration it superseded is history, and gating a merge on a verdict
        // we already replaced would block a PR over a test we ourselves rewrote.
        const bugFindings = await this.db.analysisFinding.findMany({
            where: { reportSnapshotId: snapshot.id, organizationId, currentClassification: { category: CLIENT_BUG } },
            orderBy: { testCase: { slug: "asc" } },
            select: { id: true, testCase: { select: { slug: true } } },
        });
        // Two identity spaces, each matching the store that consumes it: `SkipRecord.openFindingIds` records the
        // findings themselves, while a FindingFalsePositiveCandidate is keyed by the test slug the MCP channel
        // also reports - the two sources have to name the same thing for the FP store to be readable.
        return {
            snapshotId: snapshot.id,
            findingIds: bugFindings.map((finding) => finding.id),
            findingSlugs: bugFindings.map((finding) => finding.testCase.slug),
        };
    }

    /** Write the merge outcome onto the PR's FeatureBranchInfo row. */
    private async persistMergeFacts(params: RecordMergeParams): Promise<void> {
        const application = await this.db.application.findFirst({
            where: { organizationId: params.organizationId, githubRepositoryId: params.githubRepositoryId },
            select: { id: true },
        });
        if (application == null) {
            this.logger.warn("Merge gate: no application for merged PR; cannot persist merge facts", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
            });
            return;
        }
        await this.db.featureBranchInfo.updateMany({
            where: { applicationId: application.id, prNumber: params.prNumber },
            data: {
                mergedAt: params.mergedAt,
                mergeCommitSha: params.mergeCommitSha,
                mergedByLogin: params.mergedByLogin,
            },
        });
    }

    private async getInstallationClient(organizationId: string): Promise<GitHubInstallationClient> {
        const installation = await this.db.gitHubInstallation.findUnique({ where: { organizationId } });
        if (installation == null) throw new NotFoundError("No GitHub installation found for organization");
        return this.githubApp.getInstallationClient(installation.installationId);
    }
}
