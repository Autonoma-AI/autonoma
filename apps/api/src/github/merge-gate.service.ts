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
    MERGE_GATE_SKIP_ACTION_IDENTIFIER,
} from "@autonoma/github/check";
import { type Logger, logger } from "@autonoma/logger";
import { ANALYSIS_VERDICT } from "@autonoma/types";
import { z } from "zod";

const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

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

/** `check_run` `requested_action` payload. */
const checkRunRequestedActionWebhookSchema = z.object({
    check_run: z.object({
        id: z.number(),
        head_sha: z.string(),
        pull_requests: z.array(z.object({ number: z.number() })).optional(),
    }),
    requested_action: z.object({ identifier: z.string() }),
    repository: z.object({ id: z.number(), full_name: z.string() }),
    sender: z.object({ login: z.string() }),
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
    headSha: string;
    checkRunId: string;
    actorLogin: string;
    prNumber?: number;
    actionIdentifier: string;
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

    /** Webhook entry for `check_run.requested_action`: parse the Skip click then apply it. */
    async applySkipFromWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = checkRunRequestedActionWebhookSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("Merge gate: could not parse check_run requested_action payload", {
                organizationId,
                extra: { issues: parsed.error.issues },
            });
            return;
        }
        await this.applySkip({
            organizationId,
            repoFullName: parsed.data.repository.full_name,
            githubRepositoryId: parsed.data.repository.id,
            headSha: parsed.data.check_run.head_sha,
            checkRunId: String(parsed.data.check_run.id),
            prNumber: parsed.data.check_run.pull_requests?.[0]?.number,
            actorLogin: parsed.data.sender.login,
            actionIdentifier: parsed.data.requested_action.identifier,
        });
    }

    /**
     * Honor a Skip click (the `check_run` `requested_action` webhook): snapshot the open bugs at skip time into a
     * SkipRecord, flip the check to `neutral` (unblocks), and emit the skip signal.
     */
    async applySkip(params: ApplySkipParams): Promise<void> {
        this.logger.info("Merge gate: applySkip", {
            organizationId: params.organizationId,
            extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, actorLogin: params.actorLogin },
        });

        if (params.actionIdentifier !== MERGE_GATE_SKIP_ACTION_IDENTIFIER) {
            this.logger.info("Merge gate: ignoring non-skip requested_action", {
                extra: { actionIdentifier: params.actionIdentifier },
            });
            return;
        }
        if (!(await this.isEnabledForOrg(params.organizationId))) {
            this.logger.info("Merge gate: applySkip skipped (gate not enabled for org)", {
                organizationId: params.organizationId,
            });
            return;
        }

        const client = await this.getInstallationClient(params.organizationId);
        await this.checkRuns.runExclusive(params.repoFullName, params.headSha, async () => {
            const stored = await this.checkRuns.getByHead(params.repoFullName, params.headSha);
            const prNumber = params.prNumber ?? stored?.prNumber;
            if (prNumber == null) {
                this.logger.warn("Merge gate: cannot resolve PR number for skip; ignoring", {
                    organizationId: params.organizationId,
                    extra: { repoFullName: params.repoFullName, headSha: params.headSha },
                });
                return;
            }

            const openBugs = await this.snapshotOpenBugs(params);

            await client.updateCheckRun({
                repoFullName: params.repoFullName,
                checkRunId: params.checkRunId,
                status: "completed",
                conclusion: "neutral",
                title: `Skipped by @${params.actorLogin}`,
                summary: `@${params.actorLogin} skipped this check with ${openBugs.findingKeys.length} bug(s) open.`,
            });
            await this.checkRuns.setConclusion(params.repoFullName, params.headSha, "neutral").catch((err) => {
                this.logger.warn("Merge gate: could not persist skip conclusion (no check row for head)", {
                    organizationId: params.organizationId,
                    extra: { repoFullName: params.repoFullName, headSha: params.headSha },
                    err,
                });
            });

            const alreadyRecorded = await this.db.skipRecord.findFirst({
                where: { repoFullName: params.repoFullName, headSha: params.headSha },
                select: { id: true },
            });
            if (alreadyRecorded != null) {
                this.logger.info("Merge gate: skip already recorded for head; re-flipped check only", {
                    organizationId: params.organizationId,
                    extra: { repoFullName: params.repoFullName, headSha: params.headSha },
                });
                return;
            }

            await this.db.skipRecord.create({
                data: {
                    organizationId: params.organizationId,
                    repoFullName: params.repoFullName,
                    prNumber,
                    headSha: params.headSha,
                    snapshotId: openBugs.snapshotId,
                    actorLogin: params.actorLogin,
                    openBugCount: openBugs.findingKeys.length,
                    openFindingIds: openBugs.findingKeys,
                },
            });

            this.analytics.capture(
                params.organizationId,
                MERGE_GATE_EVENT.skipped,
                {
                    actorLogin: params.actorLogin,
                    openBugCount: openBugs.findingKeys.length,
                    prNumber,
                    repoFullName: params.repoFullName,
                },
                { [MERGE_GATE_ANALYTICS_GROUP]: params.organizationId },
            );

            this.logger.warn("Merge gate: check skipped", {
                organizationId: params.organizationId,
                extra: {
                    repoFullName: params.repoFullName,
                    prNumber,
                    actorLogin: params.actorLogin,
                    openBugCount: openBugs.findingKeys.length,
                },
            });
        });
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

    /** Read the latest snapshot at this head's open `client_bug` findings - the skip's captured signal. */
    private async snapshotOpenBugs(params: {
        organizationId: string;
        githubRepositoryId: number;
        repoFullName: string;
        headSha: string;
    }): Promise<{ snapshotId?: string; findingKeys: string[] }> {
        const { organizationId, githubRepositoryId, repoFullName, headSha } = params;
        const snapshot = await this.db.branchSnapshot.findFirst({
            where: { headSha, branch: { application: { organizationId, githubRepositoryId } } },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                analysisReport: {
                    select: {
                        findings: {
                            where: { category: CLIENT_BUG },
                            orderBy: { displayOrder: "asc" },
                            select: { findingKey: true },
                        },
                    },
                },
            },
        });
        if (snapshot == null) {
            this.logger.warn("Merge gate: no snapshot found for skipped head", {
                organizationId,
                extra: { repoFullName, headSha },
            });
            return { findingKeys: [] };
        }
        return {
            snapshotId: snapshot.id,
            findingKeys: snapshot.analysisReport?.findings.map((finding) => finding.findingKey) ?? [],
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
