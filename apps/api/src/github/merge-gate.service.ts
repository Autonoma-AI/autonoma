import type { PostHogAnalytics } from "@autonoma/analytics";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import {
    type BranchProtectionResult,
    type GitHubApp,
    type GitHubInstallationClient,
    isRepoWriteAccess,
} from "@autonoma/github";
import {
    ANALYSIS_RUN_SOURCE,
    type AnalysisRunSource,
    createGitHubCheckRunStore,
    isStartAnalysisCommand,
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
import type { AnalysisRunTrigger, RequestRunOutcome, RunNotStartedReason } from "./analysis-run-trigger";
import type { FalsePositiveCandidateService } from "./false-positive-candidate.service";
import type { MergeGateSlackNotifier } from "./merge-gate-slack-notifier";

const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

/** The un-requested check a PR opens with under activation: completed + `neutral`, so a required check never wedges. */
const UNREQUESTED_CHECK_TITLE = "No analysis requested";
const UNREQUESTED_CHECK_SUMMARY = "No analysis requested - comment `/start analysis` to run.";

/** The check a requested run flips to while the analysis is in flight, before the worker posts the real verdict. */
const IN_PROGRESS_CHECK_TITLE = "Analyzing this PR";
const IN_PROGRESS_CHECK_SUMMARY = "Autonoma is analyzing this PR for client bugs.";

/** Sentinel conclusion stored while a run is in flight - non-`failure`, so skip/bypass treat it as not-yet-blocking. */
const IN_PROGRESS_CONCLUSION = "in_progress";

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

/** The repo + PR identity every merge-gate operation is keyed by. */
export interface RepoPrRef {
    organizationId: string;
    repoFullName: string;
    githubRepositoryId: number;
    prNumber: number;
}

export interface PostPendingParams extends RepoPrRef {
    headSha: string;
}

export interface RequestAnalysisRunParams extends RepoPrRef {
    headSha: string;
    /** What asked for the run. */
    source: AnalysisRunSource;
    /** The requester's login where one exists (a comment/UI actor); absent for a system/auto trigger. */
    actorLogin?: string;
}

export interface ApplySkipParams extends RepoPrRef {
    actorLogin: string;
    /**
     * The free-text reason from the `/autonoma-skip <reason>` comment. Required and non-empty: a skip with no
     * reason is rejected before it reaches here (the reason is the public-disclosure nudge, so it is mandatory).
     */
    reason: string;
}

export interface RecordMergeParams extends RepoPrRef {
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
        // Starts the run a merge-gate trigger asked for.
        private readonly analysisRunTrigger?: AnalysisRunTrigger,
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
     * Post (once per head SHA) the `Autonoma` check when a PR opens or is synchronized. The state depends on
     * whether the org is migrated to activation:
     *
     * - migrated: nothing runs on its own, so post a COMPLETED `neutral` "no analysis requested" check. A required
     *   check must never be left hanging on an un-requested PR (which would wedge the merge), and `neutral`
     *   satisfies the requirement so the PR stays mergeable until someone comments `/start analysis`.
     * - not migrated (the fleet default): the run fires automatically, so post the `in_progress` check as before;
     *   the analysis worker flips it to the real verdict at finalize.
     */
    async postPending(params: PostPendingParams): Promise<void> {
        this.logger.info("Merge gate: postPending", {
            organizationId: params.organizationId,
            extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
        });
        const { enabled, activation } = await this.resolveGateState(params.organizationId);
        if (!enabled) {
            this.logger.info("Merge gate: postPending skipped (gate not enabled for org)", {
                organizationId: params.organizationId,
            });
            return;
        }

        const client = await this.getInstallationClient(params.organizationId);
        await this.checkRuns.runExclusive(params.repoFullName, params.headSha, async () => {
            const existing = await this.checkRuns.getByHead(params.repoFullName, params.headSha);
            if (existing != null) {
                this.logger.info("Merge gate: check already posted for head", {
                    organizationId: params.organizationId,
                    extra: { repoFullName: params.repoFullName, headSha: params.headSha },
                });
                return;
            }

            const checkRunId = activation
                ? await client.createCheckRun({
                      repoFullName: params.repoFullName,
                      headSha: params.headSha,
                      name: MERGE_GATE_CHECK_NAME,
                      status: "completed",
                      conclusion: "neutral",
                      title: UNREQUESTED_CHECK_TITLE,
                      summary: UNREQUESTED_CHECK_SUMMARY,
                  })
                : await client.createCheckRun({
                      repoFullName: params.repoFullName,
                      headSha: params.headSha,
                      name: MERGE_GATE_CHECK_NAME,
                      status: "in_progress",
                      title: IN_PROGRESS_CHECK_TITLE,
                      summary: IN_PROGRESS_CHECK_SUMMARY,
                  });
            await this.checkRuns.upsert({
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                headSha: params.headSha,
                checkRunId,
                conclusion: activation ? "neutral" : undefined,
            });
            this.logger.info("Merge gate: check posted", {
                organizationId: params.organizationId,
                extra: {
                    repoFullName: params.repoFullName,
                    prNumber: params.prNumber,
                    checkRunId,
                    state: activation ? "unrequested-neutral" : "in-progress",
                },
            });
        });
    }

    /**
     * The single entrypoint an activation trigger calls to start a run (a `/start analysis` PR comment).
     * Under the per-head lock it flips the `Autonoma` check to in-progress FIRST, then fires the run.
     * If no run actually starts (no preview, or nothing new to analyze) the check is restored to the
     * un-requested neutral state and the requester is told why. On a real start it records the activation (source +
     * actor) and emits `merge_gate.activated`. No-ops when the gate is off, the org is not migrated to activation,
     * or no run trigger is wired.
     */
    async requestAnalysisRun(params: RequestAnalysisRunParams): Promise<void> {
        this.logger.info("Merge gate: requestAnalysisRun", {
            organizationId: params.organizationId,
            extra: {
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                source: params.source,
                actorLogin: params.actorLogin,
            },
        });

        const { enabled, activation } = await this.resolveGateState(params.organizationId);
        if (!enabled) {
            this.logger.info("Merge gate: requestAnalysisRun skipped (gate not enabled for org)", {
                organizationId: params.organizationId,
            });
            return;
        }
        // Only a migrated org honors an explicit request.
        if (!activation) {
            this.logger.info("Merge gate: requestAnalysisRun skipped (org not migrated to activation)", {
                organizationId: params.organizationId,
            });
            return;
        }

        const trigger = this.analysisRunTrigger;
        if (trigger == null) {
            this.logger.error("Merge gate: requestAnalysisRun has no run trigger wired; cannot start a run", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
            });
            return;
        }

        const client = await this.getInstallationClient(params.organizationId);
        await this.checkRuns.runExclusive(params.repoFullName, params.headSha, async () => {
            const checkRunId = await this.flipCheckToInProgress(client, params);

            const outcome = await this.fireRequestedRun(trigger, params);
            if (!outcome.started) {
                await this.restoreUnrequestedCheck(client, checkRunId, params);
                await this.postCouldNotStartReply(client, params, outcome.reason);
                this.logger.info("Merge gate: requestAnalysisRun started no run; restored un-requested check", {
                    organizationId: params.organizationId,
                    extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, reason: outcome.reason },
                });
                return;
            }

            await this.checkRuns.setActivation(params.repoFullName, params.headSha, {
                source: params.source,
                actorLogin: params.actorLogin,
                activatedAt: new Date(),
            });

            this.analytics.capture(
                params.organizationId,
                MERGE_GATE_EVENT.activated,
                {
                    organizationId: params.organizationId,
                    repoFullName: params.repoFullName,
                    prNumber: params.prNumber,
                    headSha: params.headSha,
                    source: params.source,
                    actorLogin: params.actorLogin,
                },
                { [MERGE_GATE_ANALYTICS_GROUP]: params.organizationId },
            );

            this.logger.info("Merge gate: analysis run requested and check flipped to in-progress", {
                organizationId: params.organizationId,
                extra: {
                    repoFullName: params.repoFullName,
                    prNumber: params.prNumber,
                    checkRunId,
                    source: params.source,
                },
            });
        });
    }

    /** Flip (or create) the head's `Autonoma` check to in-progress and persist the sentinel. Returns its id. */
    private async flipCheckToInProgress(
        client: GitHubInstallationClient,
        params: RequestAnalysisRunParams,
    ): Promise<string> {
        const existing = await this.checkRuns.getByHead(params.repoFullName, params.headSha);
        const checkRunId =
            existing?.checkRunId ??
            (await client.createCheckRun({
                repoFullName: params.repoFullName,
                headSha: params.headSha,
                name: MERGE_GATE_CHECK_NAME,
                status: "in_progress",
                title: IN_PROGRESS_CHECK_TITLE,
                summary: IN_PROGRESS_CHECK_SUMMARY,
            }));
        if (existing != null) {
            await client.updateCheckRun({
                repoFullName: params.repoFullName,
                checkRunId,
                status: "in_progress",
                title: IN_PROGRESS_CHECK_TITLE,
                summary: IN_PROGRESS_CHECK_SUMMARY,
            });
        }
        await this.checkRuns.upsert({
            repoFullName: params.repoFullName,
            prNumber: params.prNumber,
            headSha: params.headSha,
            checkRunId,
            conclusion: IN_PROGRESS_CONCLUSION,
        });
        return checkRunId;
    }

    /** Fire the requested run, containing a trigger failure as a non-started outcome so the check can roll back. */
    private async fireRequestedRun(
        trigger: AnalysisRunTrigger,
        params: RequestAnalysisRunParams,
    ): Promise<RequestRunOutcome> {
        try {
            return await trigger.requestRun({
                organizationId: params.organizationId,
                repoFullName: params.repoFullName,
                githubRepositoryId: params.githubRepositoryId,
                prNumber: params.prNumber,
            });
        } catch (err) {
            this.logger.error("Merge gate: run trigger threw; treating as not started", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
                err,
            });
            return { started: false };
        }
    }

    /** Roll the check back to the completed neutral un-requested state, so a required check never wedges on it. */
    private async restoreUnrequestedCheck(
        client: GitHubInstallationClient,
        checkRunId: string,
        params: RequestAnalysisRunParams,
    ): Promise<void> {
        await client.updateCheckRun({
            repoFullName: params.repoFullName,
            checkRunId,
            status: "completed",
            conclusion: "neutral",
            title: UNREQUESTED_CHECK_TITLE,
            summary: UNREQUESTED_CHECK_SUMMARY,
        });
        await this.checkRuns.upsert({
            repoFullName: params.repoFullName,
            prNumber: params.prNumber,
            headSha: params.headSha,
            checkRunId,
            conclusion: "neutral",
        });
    }

    /** A PR comment telling the requester why their `/start analysis` did not start a run. */
    private async postCouldNotStartReply(
        client: GitHubInstallationClient,
        params: RequestAnalysisRunParams,
        reason?: RunNotStartedReason,
    ): Promise<void> {
        const mention = params.actorLogin != null ? `@${params.actorLogin} ` : "";
        const body =
            reason === "already_analyzed"
                ? `${mention}this PR's current commit was already analyzed - there is nothing new to run.`
                : `${mention}could not start the analysis: no live preview was found for this PR. Redeploy the preview and try again.`;
        try {
            await client.postComment(params.repoFullName, params.prNumber, body);
            this.logger.info("Merge gate: posted could-not-start reply", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, reason },
            });
        } catch (err) {
            this.logger.warn("Merge gate: failed to post could-not-start reply", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
                err,
            });
        }
    }

    /**
     * Webhook entry for `issue_comment.created`: a collaborator requests an analysis run by commenting
     * `/start analysis` on the PR.
     */
    async requestStartFromCommentWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = issueCommentWebhookSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("Merge gate: could not parse issue_comment payload for /start analysis", {
                organizationId,
                extra: { issues: parsed.error.issues },
            });
            return;
        }
        if (parsed.data.issue.pull_request == null) return; // a plain issue comment, not a PR comment
        if (!isStartAnalysisCommand(parsed.data.comment.body)) return; // any other PR comment

        const repoFullName = parsed.data.repository.full_name;
        const githubRepositoryId = parsed.data.repository.id;
        const prNumber = parsed.data.issue.number;
        const actorLogin = parsed.data.comment.user.login;

        // Stay silent unless the org is both gated AND migrated to activation - a non-migrated org still runs
        // automatically, so `/start analysis` is a no-op there.
        const { enabled, activation } = await this.resolveGateState(organizationId);
        if (!enabled || !activation) {
            this.logger.info("Merge gate: ignoring /start analysis (gate off or org not migrated to activation)", {
                organizationId,
                extra: { enabled, activation },
            });
            return;
        }

        const client = await this.getInstallationClient(organizationId);

        // Authorize the commenter the same bar as a merge override: write access to the repo.
        const permission = await client.getRepoCollaboratorPermission(repoFullName, actorLogin);
        if (!isRepoWriteAccess(permission)) {
            this.logger.info("Merge gate: /start analysis from a non-write-access commenter; ignoring", {
                organizationId,
                extra: { repoFullName, prNumber, actorLogin, permission },
            });
            return;
        }

        // The comment payload identifies the PR but not its head SHA; resolve the current head so the run and the
        // check we flip target the same commit.
        const pullRequest = await client.getPullRequest(githubRepositoryId, prNumber);

        await this.requestAnalysisRun({
            organizationId,
            repoFullName,
            githubRepositoryId,
            prNumber,
            headSha: pullRequest.headSha,
            source: ANALYSIS_RUN_SOURCE.comment,
            actorLogin,
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
     * Enable the gate for an org: flips `mergeGateEnabled` and registers `Autonoma` as a required status check on
     * each linked repo's default branch. Every org runs the analysis pipeline, so there is no longer a
     * pipeline precondition to check - the authoritative verdict the gate reads always exists.
     */
    async enableForOrg(organizationId: string): Promise<MergeGateEnableResult> {
        this.logger.info("Merge gate: enableForOrg", { organizationId });

        // Upsert, not update: nearly every org has no settings row until one is deliberately changed.
        await this.db.organizationSettings.upsert({
            where: { organizationId },
            create: { organizationId, mergeGateEnabled: true },
            update: { mergeGateEnabled: true },
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
            select: { mergeGateEnabled: true },
        });
        return settings?.mergeGateEnabled === true;
    }

    /**
     * The org's gate state in a single settings read: `enabled` is the effective runtime gate (global switch AND
     * the org's `mergeGateEnabled`); `activation` is whether the org is migrated to activation.
     */
    private async resolveGateState(organizationId: string): Promise<{ enabled: boolean; activation: boolean }> {
        if (!this.mergeGateEnabled) return { enabled: false, activation: false };
        const settings = await this.db.organizationSettings.findUnique({
            where: { organizationId },
            select: { mergeGateEnabled: true, activationEnabled: true },
        });
        const enabled = settings?.mergeGateEnabled === true;
        return { enabled, activation: settings?.activationEnabled === true };
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
