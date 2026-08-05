import { analytics } from "@autonoma/analytics";
import { db } from "@autonoma/db";
import { InsufficientPreviewCreditsError } from "@autonoma/errors";
import type { GitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { diffsTriggerService } from "../diffs/diffs-service";
import { env } from "../env";
import { previewkitTriggerService } from "../previewkit/previewkit-service";
import type { PreviewDeployAction } from "../previewkit/previewkit-trigger.service";
import { BranchContributorService } from "./branch-contributor.service";
import { BugFixOutcomeService } from "./bug-fix-outcome.service";
import { FalsePositiveCandidateService } from "./false-positive-candidate.service";
import { buildGitHubApp } from "./github-app";
import { GitHubInstallationService } from "./github-installation.service";
import { verifyInstallState } from "./github-state";
import { MergeGateSlackNotifier } from "./merge-gate-slack-notifier";
import { MergeGateService } from "./merge-gate.service";
import { PullRequestCacheService } from "./pull-request-cache.service";

type GitHubEnv = {
    Variables: {
        githubApp: GitHubApp;
        githubService: GitHubInstallationService;
    };
};

const githubApp = buildGitHubApp(env);
const githubService = new GitHubInstallationService(db, githubApp);
const prCacheService = new PullRequestCacheService(db, githubService);
const falsePositiveCandidatesService = new FalsePositiveCandidateService(db);
const mergeGateService = new MergeGateService(
    db,
    githubApp,
    env.MERGE_GATE_ENABLED,
    analytics,
    falsePositiveCandidatesService,
    diffsTriggerService,
    new MergeGateSlackNotifier(env.SLACK_BOT_TOKEN, env.MERGE_GATE_SLACK_CHANNEL),
);
const branchContributorService = new BranchContributorService(db, githubService);
const bugFixOutcomeService = new BugFixOutcomeService(db, analytics, env.MERGE_GATE_ENABLED, branchContributorService);

export const githubHttpRouter = new Hono<GitHubEnv>();

githubHttpRouter.use("*", cors({ origin: "*" }));

githubHttpRouter.use("*", async (ctx, next) => {
    ctx.set("githubApp", githubApp);
    ctx.set("githubService", githubService);
    await next();
});

githubHttpRouter.get("/callback", async (ctx) => {
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";

    const installationIdRaw = ctx.req.query("installation_id");
    const installationId = Number(installationIdRaw);
    const setupAction = ctx.req.query("setup_action");
    const state = ctx.req.query("state");

    // `install` is a fresh install; `update` is the same account changing the app's repo access
    // (the "connect another repo" flow when the app is already installed). Both carry the
    // installation_id and our signed state, so both resolve the org + returnPath and land the user
    // on the return page. `request` (approval-gated, no installation yet) and bare hits fall through.
    const isInstallOrUpdate = setupAction === "install" || setupAction === "update";
    if (Number.isNaN(installationId) || !isInstallOrUpdate) {
        // Bare hits with no install params are almost always bots/scanners/health probes; a redirect
        // that carries install params but an unhandled setup_action (e.g. `request`) is escalated to
        // fatal (routes to Sentry -> Slack), the bare case is logged quietly.
        const looksLikeGitHubRedirect = installationIdRaw != null || setupAction != null || state != null;
        const logContext = {
            extra: { installationIdRaw, setupAction, hasState: state != null },
        };
        if (looksLikeGitHubRedirect) {
            logger.fatal(
                "GitHub install callback rejected: expected setup_action=install or update with a numeric installation_id",
                logContext,
            );
        } else {
            logger.info("GitHub callback hit without install params (likely a bot or direct request)", logContext);
        }
        return ctx.redirect(`${appUrl}?error=invalid_callback`);
    }

    const statePayload = state != null ? verifyInstallState(state) : undefined;
    if (statePayload == null) {
        // Reached only after the install-params check passed, so this is a real GitHub redirect whose
        // signed state is missing/expired/tampered - escalate to fatal so it reaches Slack.
        logger.fatal("GitHub install callback rejected: missing or invalid signed state", {
            extra: { installationId, hasState: state != null },
        });
        return ctx.redirect(`${appUrl}?error=invalid_state`);
    }
    const { organizationId, returnPath } = statePayload;

    const { githubService, githubApp } = ctx.var;

    try {
        const client = await githubApp.getInstallationClient(installationId);
        const installationData = await client.getInstallation(installationId);

        const account = installationData.account as { login?: string; id?: number; type?: string } | null;

        await githubService.handleInstallation(
            installationId,
            organizationId,
            account?.login ?? "unknown",
            account?.id ?? 0,
            account?.type ?? "Organization",
        );
    } catch (error) {
        logger.fatal("Failed to handle GitHub installation callback", error, { installationId });
        const errorBase = returnPath != null ? `${appUrl}${returnPath}` : appUrl;
        const errorSeparator = errorBase.includes("?") ? "&" : "?";
        return ctx.redirect(`${errorBase}${errorSeparator}error=install_failed`);
    }

    // Success carries no marker of its own: the destination distinguishes success
    // from failure purely by the absence of an `error` param. This holds for a fresh
    // `install` and for `update` (added repo access) alike - neither needs a distinct
    // signal, and the observing tab picks up the change by refetching its repo list.
    return ctx.redirect(returnPath != null ? `${appUrl}${returnPath}` : appUrl);
});

const WEBHOOK_EVENT_TYPES = {
    "installation.created": "installation_created",
    "installation.deleted": "installation_deleted",
    "installation.suspend": "installation_suspend",
    "installation.unsuspend": "installation_unsuspend",
    "installation_repositories.added": "installation_repositories_added",
    "installation_repositories.removed": "installation_repositories_removed",
    "pull_request.opened": "pull_request_opened",
    "pull_request.synchronize": "pull_request_synchronize",
    "pull_request.closed": "pull_request_closed",
    "pull_request.reopened": "pull_request_reopened",
    "pull_request.ready_for_review": "pull_request_ready_for_review",
    "pull_request.labeled": "pull_request_labeled",
    "issue_comment.created": "issue_comment_created",
    // push payloads carry no `action`; the event name alone is the key.
    push: "push",
} as const;

/** The internal event names this handler dispatches on, derived from the map. */
type GitHubWebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[keyof typeof WEBHOOK_EVENT_TYPES];

githubHttpRouter.post("/webhook", async (ctx) => {
    const body = await ctx.req.text();
    const signature = ctx.req.header("x-hub-signature-256") ?? "";
    const event = ctx.req.header("x-github-event") ?? "";
    const deliveryId = ctx.req.header("x-github-delivery") ?? "";

    const { githubApp, githubService } = ctx.var;

    const isValid = await githubApp.verifyWebhook(body, signature);
    if (!isValid) {
        logger.warn("Invalid GitHub webhook signature");
        return ctx.json({ error: "Invalid signature" }, 401);
    }

    if (deliveryId === "") {
        logger.warn("GitHub webhook missing X-GitHub-Delivery header");
        return ctx.json({ error: "Missing delivery id" }, 400);
    }

    const payload = JSON.parse(body) as Record<string, unknown>;
    const action = payload.action as string | undefined;
    const eventKey = action != null ? `${event}.${action}` : event;
    const eventType = isWebhookEventKey(eventKey) ? WEBHOOK_EVENT_TYPES[eventKey] : undefined;

    const installation = payload.installation as { id: number; account?: { login?: string } } | undefined;
    const installationId = installation?.id;

    // Ignore events we don't model. GitHub retries non-2xx, so still return 200.
    if (eventType == null || installationId == null) {
        logger.info("GitHub webhook: ignored event", { event, action, deliveryId });
        return ctx.json({ ok: true, ignored: true });
    }

    const organizationId = await githubService.findOrganizationIdByInstallationId(installationId);
    if (organizationId == null) {
        logger.warn("GitHub webhook: no organization linked to installation", { installationId, deliveryId });
        return ctx.json({ ok: true, ignored: true });
    }

    // Ack immediately and process in the background. Superseding an in-flight
    // preview deploy waits (tens of seconds) for the old run to cancel
    // gracefully before starting its replacement; awaiting that here would blow
    // GitHub's 10s webhook delivery timeout and surface as failed deliveries.
    // The dispatched work is durable (Temporal), so a thrown error only needs
    // logging: GitHub gets 200 either way, and redelivery would not help.
    void dispatchWebhookEvent(eventType, installationId, organizationId, githubService, prCacheService, payload).catch(
        (error) => {
            // undici's `fetch failed` puts the real reason (DNS / ECONNREFUSED / etc) in .cause.
            const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
            const causeMessage = cause instanceof Error ? cause.message : cause != null ? String(cause) : undefined;
            logger.fatal("Error processing GitHub webhook", error, { event, deliveryId, cause: causeMessage });
        },
    );

    return ctx.json({ ok: true });
});

async function dispatchWebhookEvent(
    type: GitHubWebhookEventType,
    installationId: number,
    organizationId: string,
    githubService: GitHubInstallationService,
    prCacheService: PullRequestCacheService,
    payload: Record<string, unknown>,
): Promise<void> {
    switch (type) {
        case "installation_created":
            // Installation is persisted via the OAuth callback (which has org context).
            // The webhook fires too — we only log it here.
            logger.info("installation.created webhook (installation row handled via callback)", { installationId });
            return;
        case "installation_deleted":
            await githubService.handleUninstall(installationId);
            return;
        case "installation_suspend":
            await githubService.handleSuspend(installationId);
            return;
        case "pull_request_opened":
            await prCacheService.updateFromWebhook(organizationId, payload);
            await startPullRequestDeploy("opened", organizationId, payload);
            await mergeGateService.postPendingFromWebhook(organizationId, payload);
            await branchContributorService.refreshFromWebhook(organizationId, payload);
            return;
        case "pull_request_synchronize":
            await prCacheService.updateFromWebhook(organizationId, payload);
            await startPullRequestDeploy("synchronize", organizationId, payload);
            await mergeGateService.postPendingFromWebhook(organizationId, payload);
            await branchContributorService.refreshFromWebhook(organizationId, payload);
            return;
        case "pull_request_reopened":
            await prCacheService.updateFromWebhook(organizationId, payload);
            await startPullRequestDeploy("reopened", organizationId, payload);
            await mergeGateService.postPendingFromWebhook(organizationId, payload);
            await branchContributorService.refreshFromWebhook(organizationId, payload);
            return;
        case "pull_request_ready_for_review":
            // A draft marked ready for review is no longer a draft, so the
            // draft gate in startRunFromPullRequestWebhook lets it through and the preview
            // builds even for orgs that skip draft PRs. The activation
            // auto-run-on-ready trigger is NOT fired here: the preview does not
            // exist yet at this moment (it is built in response to this event),
            // so the run would find no preview. It fires later, once the preview
            // is live, from the shared PR-diffs trigger (see `autoRunsOnReady`).
            await prCacheService.updateFromWebhook(organizationId, payload);
            await startPullRequestDeploy("ready_for_review", organizationId, payload);
            await mergeGateService.postPendingFromWebhook(organizationId, payload);
            await branchContributorService.refreshFromWebhook(organizationId, payload);
            return;
        case "pull_request_labeled":
            await mergeGateService.requestStartFromLabelWebhook(organizationId, payload);
            return;
        case "pull_request_closed":
            await prCacheService.updateFromWebhook(organizationId, payload);
            await startPullRequestTeardown(organizationId, payload);
            await mergeGateService.recordMergeFromWebhook(organizationId, payload);
            await branchContributorService.refreshFromWebhook(organizationId, payload);
            await bugFixOutcomeService.recordFromWebhook(organizationId, payload);
            return;
        case "issue_comment_created":
            await mergeGateService.applySkipFromCommentWebhook(organizationId, payload);
            await mergeGateService.requestStartFromCommentWebhook(organizationId, payload);
            return;
        case "push":
            await startMainBranchPushDeploy(organizationId, payload);
            return;
        default:
            return;
    }
}

function isWebhookEventKey(key: string): key is keyof typeof WEBHOOK_EVENT_TYPES {
    return Object.hasOwn(WEBHOOK_EVENT_TYPES, key);
}

/**
 * Deploy path for pull_request opened/synchronize/reopened: starts the deploy
 * workflow directly. Silently skipped when previews are disabled (dev /
 * self-host without preview infrastructure).
 */
async function startPullRequestDeploy(
    action: PreviewDeployAction,
    organizationId: string,
    payload: Record<string, unknown>,
): Promise<void> {
    try {
        await previewkitTriggerService.startRunFromPullRequestWebhook(action, organizationId, payload);
    } catch (error) {
        if (!(error instanceof InsufficientPreviewCreditsError)) throw error;
        logger.info("Skipped preview deploy: organization is out of credits", { action, organizationId });
    }
}

/** Teardown path for pull_request.closed. */
async function startPullRequestTeardown(organizationId: string, payload: Record<string, unknown>): Promise<void> {
    await previewkitTriggerService.teardownFromWebhook(organizationId, payload);
}

/**
 * Deploy path for push: redeploys the main-branch preview environment at the
 * pushed head, the same way `synchronize` updates a PR environment.
 */
async function startMainBranchPushDeploy(organizationId: string, payload: Record<string, unknown>): Promise<void> {
    try {
        await previewkitTriggerService.startMainBranchRunFromPushWebhook(organizationId, payload);
    } catch (error) {
        if (!(error instanceof InsufficientPreviewCreditsError)) throw error;
        logger.info("Skipped main-branch push deploy: organization is out of credits", { organizationId });
    }
}
