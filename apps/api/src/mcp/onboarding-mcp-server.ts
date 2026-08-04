import { needsHuman } from "@autonoma/agent-guidance";
import type { OnboardingPreviewEnvironmentMode, PrismaClient } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import {
    type AgentLogEntry,
    buildDeploymentSignalWorkflow,
    DEPLOYMENT_SIGNAL_BODY_FIELDS,
    authoringPreviewConfigSchema,
    isProtectedPreviewkitEnvKey,
    type OnboardingAgentPendingRequest,
    ScenarioRecipeSchema,
} from "@autonoma/types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { env } from "../env";
import { INSTALL_STATE_TTL_MS, createInstallState } from "../github/github-state";
import type { Services } from "../routes/build-services";
import type { PreviewReadiness } from "../routes/onboarding/preview-readiness";
import type { VercelDeploymentSummary } from "../vercel-marketplace/vercel-project-api";
import { deprecatedBuildNotice } from "./deprecated-build-notice";
import { dryRunOptions } from "./dry-run-options";
import type { McpAnalytics } from "./mcp-analytics";
import type { McpPrincipal } from "./mcp-principal";
import { baseFingerprintInput, recipeConflictResult } from "./recipe-conflict-result";
import { resolveDryRunTarget, resolveDryRunTargetUrl } from "./resolve-dry-run-target";
import { resolveMcpTarget } from "./resolve-mcp-target";
import { registerSharedReadTools } from "./shared-read-tools";
import { describeError, errorResult, jsonResult, toToolResult, unavailableResult } from "./tool-result";
import {
    VERCEL_PLAYBOOK,
    type VercelState,
    describeVercelBuildNextStep,
    describeVercelNextStep,
    describeVercelState,
    isVercelPath,
} from "./vercel-onboarding-guidance";

/**
 * How many recent log lines get_session_status returns per source. Enough to carry
 * the failing step (e.g. a `pnpm install` error) without flooding a polled tool.
 */
const RECENT_LOG_TAIL_LINES = 30;
/** Line window get_target_logs reads when the agent does not ask for one, and its ceiling. */
const DEFAULT_TARGET_LOG_LINES = 200;
const MAX_TARGET_LOG_LINES = 1000;
const ACTIVITY_DESCRIPTION_MAX_LENGTH = 120;

/**
 * An optional short, human-readable summary an agent attaches to a write. The user
 * watches these on the read-only activity feed, so a legible line ("Set up boss-roast
 * on Node with a Redis cache") reads far better there than the raw tool name + args.
 */
const activityDescription = z
    .string()
    .max(ACTIVITY_DESCRIPTION_MAX_LENGTH)
    .optional()
    .describe("A short human-readable summary of this action, shown to the user on the activity feed.");

/** A short tail of one log stream, attached to get_session_status so a polling agent sees why a deploy failed. */
interface RecentLogTail {
    source: "build" | "app";
    lines: string[];
}

/**
 * The path-neutral half of the guidance, read on connect. Deliberately short and
 * says almost nothing about HOW to configure anything: an app can be on either
 * of two very different paths, and which one is only known once the agent pairs.
 * `playbookFor` supplies the rest, and `pair` hands it over.
 */
const SHARED_PREAMBLE = `Autonoma runs your end-to-end tests against a preview deployment of your app. These tools let a coding agent do the whole of onboarding while the user watches read-only in the Autonoma UI. This is the only Autonoma MCP you need for onboarding; there is a separate one for reviewing pull requests later.

An app gets its previews one of two ways, and they need completely different work from you:
- **Autonoma-hosted** - Autonoma builds and hosts a preview per pull request. You write the build, services and env config here and deploy through these tools.
- **Their own pipeline** - the project already builds previews. Autonoma deploys NOTHING; you connect those previews so Autonoma knows when one is live.
Do not guess which one: pair(code) returns \`previewSource\` and the full playbook for it. Follow the playbook it gives you.

On their own pipeline there are two ways Autonoma learns a preview is live, and the playbook you get names which applies - do not assume the webhook. If the project is on **Vercel**, Autonoma's Marketplace integration reports deployments already, and the work is connecting the project (get_vercel_setup); hand-writing a signed webhook there produces previews Autonoma cannot even reach, because linking the project is also what applies the deployment-protection bypass. Every other host is the signed webhook (get_signal_setup).

Which to pick is a question about where test data lands, and the two options are NOT equally safe. An Autonoma-hosted preview gets its own database, so a run creates and destroys data in an environment nothing else shares. Their own previews point at a real database - commonly staging, sometimes production - so a run writes into it, and anything it creates that no tenant owns STAYS there. Picture a marketplace with no per-preview database: a test run creates listings, and real users see them.
- No preview environments today - Autonoma-hosted, since there is nothing to connect to.
- Previews today, and every row of data hangs off a tenant (an org/account/workspace that can be deleted whole) - either works. Wiring their existing previews is less to change, so prefer it only when you are CONFIDENT the tenant covers everything.
- Previews today, but data is NOT cleanly tenant-scoped - Autonoma-hosted, even though previews already exist.
- **Not sure? Pick Autonoma-hosted.** Being wrong that way costs a preview we build for them anyway. Being wrong the other way writes test data into their real database in front of their users, and we cannot take it back. Never pick their-pipeline just because previews exist - you must also be sure a run cannot leave anything behind.

Start every session by pairing - and pair FIRST, before you analyze the repo, read files, or plan. Pairing is low-risk: it only claims the app's config so the UI can show you are connected, it changes NO code and deploys NOTHING, and the user can take over at any time. This matters because the user is watching the Autonoma UI live and sees no activity at all until you pair - pairing is what flips the UI into "your agent is connected and configuring" and starts streaming what you do as feedback. If you spend minutes inspecting the project before pairing, the user just stares at an idle screen with no idea anything is happening (and may give up). So do NOT front-load repo analysis; pair immediately, then investigate.
1. The user starts onboarding in the Autonoma UI and clicks "Configure with coding agent". The UI shows a short pairing CODE.
2. Call pair(code) with it IMMEDIATELY, as your very first action - then do any repo analysis you need. That claims the app for you and returns its applicationId, how it gets its previews, and the playbook to follow. Use that applicationId for every other tool.
3. CHECK YOU ARE IN THE RIGHT REPO. pair returns \`repository\` - the repo this app is linked to. Confirm your working directory is that repo (\`git remote get-url origin\`) BEFORE you read a single file. An agent run from the wrong checkout will happily analyze an unrelated codebase and pick a path from evidence that has nothing to do with the app. If it does not match, stop and tell the user rather than guessing.
4. If pair reports \`previewSource: "not-chosen-yet"\`, the choice is yours to make: read the repo (does it already build previews? is every table owned by a tenant you could delete whole?), pick using the trade-off above, and call select_preview_path. Do that from evidence in the code rather than by asking the user to self-assess - you can read the schema, they are guessing. Tell them what you picked and why. Only fall back to asking if the repo genuinely does not say.

Every playbook is also readable on demand, without pairing, so a long session that has pushed one out of context can re-read it instead of guessing: \`autonoma://autonoma-hosted-playbook\`, \`autonoma://vercel-playbook\`, \`autonoma://own-pipeline-playbook\`. Read the one pair() named, not the one you remember.

Control: you hold the config while you work; the UI is read-only. If get_session_status (or any write) reports the user took over (standDown / paused), STOP configuring and let them - do not fight for control. They can hand it back with "Resume with Claude" and you re-claim on your next call. If you go idle for a while the UI hands control back automatically; just resume when the user asks.`;

/** Autonoma builds the preview, so the build/service/env config lives here. */
const PREVIEWKIT_PLAYBOOK = `This app uses **Autonoma-hosted previews**: Autonoma builds and hosts them, so the build, services, env and deploy all go through these tools.

Your tools here: get_config, apply_config, request_env, trigger_deploy, get_session_status, get_target_logs. The signal tools (get_signal_setup, get_signal_status, confirm_signal_setup) are for apps on their own pipeline and do not apply - ignore them.

Loop until the preview is up:
1. get_config(applicationId) - read the current preview config.
2. apply_config(applicationId, document) - save the FULL config document (call get_config first, edit it, send the whole thing back). It is validated on save; if invalid, the error tells you what to fix.
3. If the app needs secret env values (third-party API keys, tokens) you do NOT have: call request_env(applicationId, keys), then keep polling get_session_status (step 5) until the request clears - that poll is the only thing that tells you the values landed. NEVER put secret values in any tool call - you cannot, there is no tool that takes them. The user enters them in the Autonoma UI. ALWAYS ask the user first whether to set env on Autonoma from their .env (the default, they paste it into the UI) or configure them manually. Never request AUTONOMA_* variables (AUTONOMA_PREVIEWKIT, AUTONOMA_PREVIEWKIT_PR, AUTONOMA_PREVIEWKIT_URL, AUTONOMA_SHARED_SECRET, AUTONOMA_SIGNING_SECRET) - Autonoma injects all of them automatically and rejects attempts to set them. Non-secret config (e.g. NODE_ENV) belongs in apply_config as an app connection, and so does the URL of a service that lives INSIDE the preview (its own Postgres, Redis, ...) - that URL only exists at deploy time, so wire it as a connection instead of asking the user for it.
4. trigger_deploy(applicationId) - deploy the base preview environment (environment 0). It deploys the app's configured deploy branch. Pick that branch deliberately rather than defaulting to a name: if unset it uses the repo's default branch (whatever it is named), which is the right choice when the user is working on it. But you typically run from the user's local checkout, which may sit on a different branch - check it (e.g. \`git rev-parse --abbrev-ref HEAD\`). If it is NOT the repo default (e.g. a branch they made to integrate Autonoma), ASK the user whether to deploy that branch or the default, then set their answer with apply_config's \`branch\` field (that does NOT deploy on its own) before trigger_deploy. Do not steer toward any particular branch without cause.
5. get_session_status(applicationId) - poll this for both "is the build done" and "did the user answer my request". It returns the deploy status, the preview URL, diagnostics, and your control state. While a request is pending, KEEP POLLING: wait ~30s (sleep, if your client can) and call it again, for as long as it takes - a user can be several minutes away from a key they have to go dig up, and until you poll again you have no idea whether they answered. Nothing else tells you: they set the values in the Autonoma UI, so a quiet chat means nothing either way. (If they do say in the chat that they are done, great - poll once to pick it up and carry on.) When the request clears, check lastEnvResolution: the user may have SKIPPED keys they don't have (skippedKeys) - adapt the config to live without them (default, drop, or rework) instead of re-requesting.
6. A ready status only means the pod health check passes - it does NOT mean the app works. Before declaring the preview done, verify it yourself: exercise the main flow against the preview URL (curl it, or a small Playwright script if the user has Playwright - log in, load data, hit a few real routes), then call get_session_status again and READ the app's runtime logs in recentLogs. If the logs show the app erroring behind the healthy page (crashed queries, missing env, stack traces), fix the cause and redeploy. If you cannot exercise the flow yourself, ask the user to click through the app once and then read the logs.

Which app hosts the Autonoma SDK: set \`sdk_implemented: true\` on the app whose code serves the Environment Factory handler (the \`/api/autonoma\` route) - every scenario up/down is sent there. Set it on exactly one app, in the same apply_config call as the rest of the topology, as soon as you know where the handler lives. It is INDEPENDENT of \`primary\`: a full-stack app (Next.js, Rails, Django) is both the app the agents browse and the SDK host, so it carries both flags; a split topology marks the frontend \`primary\` and the API service \`sdk_implemented\`. Leave it unset and Autonoma falls back to the primary app, which makes every up 404 when the handler actually lives on another service.

Connections wire env vars to the preview's own topology, resolved at deploy time - services do NOT auto-inject anything into apps. If an app needs to reach a database/service declared in this config, you MUST add a connection on that app. The value is a template: {{name.property}} tokens reference apps/services by name. For a service, {{db.url}} is the full canonical connection string (postgres -> postgresql://preview:preview@<host>:<port>/preview) - prefer it; {{db.host}} / {{db.port}} exist for hand-built URLs. For an app, {{api.url}} is its public HTTPS URL. {{pr}}, {{namespace}} and {{owner}} are also available. Example: apps[].connections = [{ "key": "DATABASE_URL", "value": "{{db.url}}" }].`;

/**
 * The bring-your-own-deploys path. The work here is not configuration - there is
 * none - it is wiring the customer's existing pipeline to make one signed call,
 * then proving it fired. The starter workflow is framed as a template on purpose:
 * it hangs off GitHub's `deployment_status`, which plenty of pipelines never emit.
 */
const EXTERNAL_DEPLOYS_PLAYBOOK = `This app uses **its own pipeline** for previews: the project already builds them. Autonoma deploys NOTHING here, and there is no build config to write. Your job is to make their pipeline tell Autonoma when a preview is live, then prove it worked.

1. get_signal_setup(applicationId) - returns the endpoint, the applicationId, the shared secret, the exact body + signature contract, and a starter GitHub Actions workflow. Treat that workflow as a TEMPLATE, not a requirement: it hangs off GitHub's \`deployment_status\` event, which many pipelines never emit. READ how this project actually deploys (its CI config, its host) and make the same signed call from whatever step knows a preview is live - a deploy job, a post-deploy script, the host's own webhook.
2. Wire it into the repo, conventionally on a branch + PR so the user reviews it rather than you pushing to main. Two things to get right: sign the EXACT bytes you POST (re-serializing the JSON after signing changes the digest and the call is rejected), and put the shared secret in the pipeline's secret store (e.g. \`gh secret set AUTONOMA_SHARED_SECRET\`) rather than committing it.
3. On a pull-request deploy, send \`branch\` and \`prNumber\` TOGETHER - that is what turns a signal into a per-PR review. A signal carrying neither is recorded as a main-branch deploy. A signal carrying \`branch\` but NOT \`prNumber\` is IGNORED entirely, so never send one without the other.
4. If one pull request deploys several services (frontend, API, database), signal only the one Autonoma should browse. Every signal overwrites the stored preview URL, so signalling all of them means whichever deploy finishes last wins - and that may be the API rather than the frontend.
5. get_signal_status(applicationId) - poll until \`signalReceived\` is true. That is the ONLY confirmation the wiring works. Prove it with a real run of their pipeline (push the branch, let it deploy) rather than a hand-written curl: a curl you wrote proves your curl works, not that their pipeline calls us.
6. confirm_signal_setup(applicationId) - once a signal has landed, mark setup done so onboarding advances.

\`prReviewsConfirmed\` in get_signal_status turns true the first time a signal arrives carrying a prNumber. Until that happens the app records preview URLs but never reviews a pull request, so do not call the wiring finished on a main-branch signal alone.

Your tools here: get_signal_setup, get_signal_status, confirm_signal_setup, plus the scenario/recipe tools once a preview URL exists.

There is no config to write, no deploy to trigger and no build logs to read: apply_config, trigger_deploy, request_env and get_target_logs only apply to Autonoma-hosted previews and will refuse if you call them here.`;

/** SDK endpoint + scenario recipes - identical once a preview URL exists, whichever path produced it. */
const SDK_AND_RECIPES = `The SDK (environment factory): once the preview is up, the app needs ONE POST endpoint at \`/api/autonoma\` that creates and tears down a scenario's test data. The user implements it in their repo - conventionally on a PR titled "feat: autonoma-sdk", so they iterate on a branch instead of pushing to main - and every preview of that PR is its own environment. On Vercel, make that branch BEFORE you pick the deployment onboarding points at, not after: Vercel builds a preview for every branch pushed, and that preview is the only one that will contain the handler, so pointing onboarding at it means never having to re-point it later (and a fresh build already carries the injected shared secret, so nothing needs rebuilding). The Vercel playbook's step 4 is this same instruction from the other side. list_dry_run_targets(applicationId) lists them (the base \`main\` preview plus each open PR) and flags the one auto-detected as the SDK PR; work against that target, not against main. Then validate_sdk(applicationId, target) calls the handler's \`discover\` and stores the schema it returns - do this before any dry run. When it fails, the returned error is the handler's own; get_target_logs(applicationId, target, source:"app") is where the stack trace behind it lives. Note that get_session_status ONLY ever reports the base preview, so on this phase it tells you nothing about the PR you are validating - use list_dry_run_targets for that target's deploy state and get_target_logs for its output.

Scenario recipes (test data): a scenario is a named app state a test depends on (e.g. "logged-in admin with one open invoice"); its recipe is the JSON your deployed Autonoma SDK follows to create those entities in the app's OWN database at test time. Before onboarding finishes the recipe often does not work yet, so fix it here: list_scenarios(applicationId) shows the app's scenarios and which already have a recipe; get_recipe(scenarioId) reads one; update_recipe(scenarioId, recipe) saves a corrected version (the recipe's \`name\` must stay the scenario's name - this EDITS an existing scenario, it does not create one; the recipe shape is validated on save and an invalid one is rejected with the exact bad field paths, so read them and resend); dry_run_scenario(scenarioId, recipe?) runs a recipe end-to-end against the deployed app (calls the SDK \`up\` to create the entities, then \`down\` to tear them back down) and, on failure, returns which phase failed (recipe/up/down) and the SDK's error - pass your edited \`recipe\` to try it WITHOUT storing it, which is how you iterate. This needs the app deployed with its SDK URL + signing secret configured, so get the preview up first. A scaled-to-zero preview 503s on the first call while it wakes; dry_run_scenario rides through that warm-up automatically, so give the first run ~a minute before concluding anything is wrong (and if it still comes back with a cold-start/503, just call it again - it is waking).

How to iterate on a failing recipe - first tell apart the TWO things that can be wrong, because they iterate very differently. (1) The recipe JSON (a bad \`create\` graph, a wrong field, a \`_ref\` matching no \`_alias\`): iterate with dry_run_scenario(scenarioId, recipe) - it provisions your candidate without storing it, so the app keeps working off its current recipe while you experiment, and a wrong guess costs nothing. The recipe lives on Autonoma, so each attempt takes effect with NO redeploy. When one passes, re-run it with \`save: true\` (or call update_recipe) to make it the active recipe; do NOT save a recipe you have not seen pass. (2) The app's SDK handler code that interprets the recipe and writes to the database (a missing factory for a model, a broken insert): that lives in the app's repo and only changes when the app is REBUILT, and its thrown errors land in get_target_logs(target, source:"app") - read them before guessing. Commit the fix and push it to the branch whose preview you are testing: if you are working a target from list_dry_run_targets, that is the SDK PR's branch, and pushing to it redeploys that preview on its own. If instead you are on the base preview, push to \`deployBranch\` (returned by get_config / pair) and call trigger_deploy to rebuild it, polling get_session_status until it is \`ready\` again. Either way wait for the redeploy BEFORE you dry_run - against a preview that is still building you would just be testing the old code (list_dry_run_targets reports each target's availability). Fastest of all: iterate the SDK handler and recipe LOCALLY first - run the app's Autonoma SDK against a local server + database, exercise the recipe, and confirm the rows actually landed in the DB - then push/update only once it works. A local loop is seconds; a cloud rebuild is minutes.`;

const ONBOARDING_INSTRUCTIONS = `${SHARED_PREAMBLE}

${SDK_AND_RECIPES}`;

/** How the agent is told which way an app gets its previews - never the internal enum value. */
function previewSourceOf(
    mode: OnboardingPreviewEnvironmentMode | undefined,
): "autonoma-hosted" | "their-pipeline" | "not-chosen-yet" {
    if (mode === "previewkit") return "autonoma-hosted";
    if (mode === "existing_deploys") return "their-pipeline";
    return "not-chosen-yet";
}

/**
 * The path-specific half of the guidance, handed over by `pair` once the app's
 * mode is known. An app that has not chosen yet gets both, since the user is
 * about to pick one in the UI and the agent should recognise either.
 */
function playbookFor(mode: OnboardingPreviewEnvironmentMode | undefined, vercel: VercelState): string {
    const external = isVercelPath(vercel) ? VERCEL_PLAYBOOK : EXTERNAL_DEPLOYS_PLAYBOOK;
    if (mode === "previewkit") return PREVIEWKIT_PLAYBOOK;
    if (mode === "existing_deploys") return external;
    return `This app has not picked a path yet, so picking it is your first job: read the repo, decide with the trade-off in the preamble, and call select_preview_path. Both playbooks follow so you can see what each commits you to.\n\n${PREVIEWKIT_PLAYBOOK}\n\n${external}`;
}

/** Everything the onboarding MCP tools need: the service graph and the authenticated user. */
export interface OnboardingMcpDeps {
    services: Services;
    db: PrismaClient;
    /** The authenticated caller and the complete set of orgs it may act in. */
    principal: McpPrincipal;
    /** Records a `mcp.tool_called` PostHog event per tool invocation, attributed to the resolved org. */
    analytics: McpAnalytics;
}

/** Identifies a single guarded write for the mutex claim and the activity stream. */
interface GuardedWriteParams {
    applicationId: string;
    /** The MCP tool name, used as the log-entry label and in failure logs. */
    tool: string;
    /** Human-readable description shown on the "running" activity row in the UI. */
    message: string;
    /** Rendered as dim JSON on the activity row; never carries secret values. */
    toolArguments?: AgentLogEntry["toolArguments"];
    /**
     * Refuse this write when the app gets its previews the other way, naming the
     * tool to use instead. Config/deploys/env only mean something for previews
     * Autonoma builds; the signal tools only mean something for previews it does
     * not. Checked BEFORE claiming the app, so a wrong-path call does not take
     * control or open an activity entry it will only fail out of.
     */
    requires?: {
        source: OnboardingPreviewEnvironmentMode;
        useInstead: string;
        /**
         * Redirect to use when the app turns out to be on Vercel. Without it a
         * previewkit-only tool sends every customer-pipeline app to the webhook
         * tools - and `get_signal_setup` refuses a linked Vercel project, so the
         * agent is bounced between two tools that each point at the other.
         */
        useInsteadOnVercel?: string;
    };
}

/**
 * The next move to spell out on a poll that still has a request pending. Agents
 * reliably stop here and wait to be told the values are in, which strands the
 * onboarding: the user sets them in the UI and comes back much later to find the
 * agent never noticed. Saying it in the payload puts the instruction in front of
 * the agent at the moment it decides whether to poll again. Undefined - and so
 * absent from the JSON - when nothing is pending.
 */
function describePendingRequest(pending: OnboardingAgentPendingRequest | undefined): string | undefined {
    if (pending == null) return undefined;
    return (
        "The user has not answered yet. Wait ~30s and call get_session_status again, and keep doing that for as " +
        "long as it takes - they answer in the Autonoma UI, so this call is the only thing that will tell you the " +
        "values are set."
    );
}

/**
 * The activity-feed line for a dry run when the agent gave no description. The user is
 * watching to know whether their recipe is being changed, so trying an unsaved candidate
 * and promoting one must not read the same.
 */
function describeDryRun(hasCandidate: boolean, save: boolean): string {
    if (!hasCandidate) return "Testing the saved scenario recipe";
    return save ? "Testing an edited recipe, saving it if it passes" : "Testing an edited recipe (not saved)";
}

/**
 * Where a customer pipeline POSTs its signal.
 *
 * Built from the same origin MCP clients already dial (`MCP_RESOURCE_URL`, the
 * dedicated `api.<host>` in prod/beta, falling back to the API's own base URL).
 * Deriving `api.<APP_URL host>` by hand instead would emit `api.localhost:3000`
 * in local dev, which resolves nowhere.
 */
function signalEndpoint(): string {
    const origin = env.MCP_RESOURCE_URL ?? env.BETTER_AUTH_URL ?? env.APP_URL;
    return new URL("/v1/onboarding/deployment-signal", origin).toString();
}

/**
 * The move to spell out on a signal-status poll. Agents reliably stop at "no
 * signal yet" and wait to be told, which strands the wiring; and a main-branch
 * signal reads as success even though no pull request will ever be reviewed.
 */
function describeSignalNextStep(status: { signalReceived: boolean; prReviewsConfirmed: boolean }): string {
    if (!status.signalReceived) {
        return (
            "No signal yet. Trigger a real deploy on their pipeline and poll this again - a signal only arrives " +
            "once their pipeline actually runs the call, so waiting without deploying will never clear this."
        );
    }
    if (!status.prReviewsConfirmed) {
        return (
            "A signal landed, so the wiring works - but none has carried a prNumber yet, so no pull request will be " +
            "reviewed. Check the call sends `branch` and `prNumber` together on a pull-request deploy, then open or " +
            "update a PR and poll again."
        );
    }
    return "Signals are landing and one carried a pull request, so per-PR reviews are wired. Call confirm_signal_setup if you have not already.";
}

/**
 * The refusal a path-specific tool returns when the app is on the other path.
 * Names the tool to use instead: an agent told only "not supported" tends to
 * retry with different arguments, whereas a redirect moves it onto the right
 * playbook. Phrased from `requires` rather than fixed, since the guard runs in
 * both directions - config/deploy/env tools refuse on the customer's own
 * pipeline, and the signal/Vercel tools refuse on Autonoma-hosted previews.
 */
function wrongPathResult(tool: string, requires: OnboardingPreviewEnvironmentMode, useInstead: string): CallToolResult {
    const explanation =
        requires === "previewkit"
            ? `${tool} only applies to Autonoma-hosted previews. This app builds its previews on its own pipeline, so ` +
              "there is no Autonoma-side config, deploy or build log here."
            : `${tool} only applies to previews the project builds itself. Autonoma hosts this app's previews, so ` +
              "there is no external pipeline or Vercel project to connect.";
    return errorResult(`${explanation} Use ${useInstead} instead, and re-read the playbook that pair returned.`);
}

/** The result a write tool returns when the human has taken over - the agent must stand down. */
function pausedResult(): CallToolResult {
    return jsonResult({
        status: "paused",
        standDown: true,
        message:
            "The user took over configuration in the Autonoma UI. Stop configuring and let them continue. " +
            "They can hand control back with 'Resume with Claude', after which your next call re-claims it.",
    });
}

/**
 * Builds the "onboarding" MCP server: the client-facing toolset a coding agent
 * uses to configure a preview during onboarding. The app is pinned by
 * a pairing code (not a repo name); every tool resolves the org from the
 * per-call `applicationId` and verifies the authenticated user's membership.
 * Writes go through the {@link OnboardingAgentSessionService} soft mutex so the
 * UI can watch read-only and take over. Secret VALUES never pass through any tool.
 */
export function buildOnboardingMcpServer(deps: OnboardingMcpDeps): McpServer {
    const logger = rootLogger.child({ name: "onboardingMcpServer" });
    const { services, db, principal, analytics } = deps;
    const userId = principal.userId;
    const session = services.onboardingAgentSession;

    const server = new McpServer(
        { name: "autonoma-onboarding", version: "0.1.0" },
        { instructions: ONBOARDING_INSTRUCTIONS },
    );

    /**
     * Resolve the org from a tool's `applicationId` (verifying the user's
     * membership) and bind it to the analytics scope, so each tool's
     * `mcp.tool_called` event is attributed to the customer org. Use this in every
     * tool instead of calling the service directly.
     */
    const resolveOrg = analytics.observeOrgResolution(async (applicationId) => {
        const target = await resolveMcpTarget(
            { db, listRepositories: (orgId) => services.github.listRepositories(orgId) },
            principal,
            { applicationId },
        );
        return target.organizationId;
    });

    /**
     * The recent log tail attached to get_session_status so a polling agent can see
     * WHY a deploy failed and fix it, instead of looping blindly on a phase string.
     * A failed build (a broken `pnpm install`, a bad Dockerfile) lives in build logs;
     * a container that built then crashed lives in app logs. So while building we show
     * build, when up we show app, and on failure we return both - the failure could be
     * either, and the agent needs whichever line actually carries the error.
     * Best-effort: a log-tail failure (Loki unset or down) never fails the poll.
     */
    async function tailPhaseLogs(
        organizationId: string,
        diagnostics: PreviewReadiness["diagnostics"],
    ): Promise<RecentLogTail[]> {
        const { logs, status } = diagnostics;
        if (!logs.available) return [];

        const sources: Array<"build" | "app"> =
            status === "ready" ? ["app"] : status === "failed" ? ["build", "app"] : ["build"];
        const tails = await Promise.all(
            sources.map(async (source): Promise<RecentLogTail | undefined> => {
                try {
                    const tail = await services.previewkitLogs.tail({
                        repoFullName: logs.repoFullName,
                        prNumber: logs.prNumber,
                        source,
                        callerOrgId: organizationId,
                        limit: RECENT_LOG_TAIL_LINES,
                        from: "tail",
                    });
                    if (tail == null || !tail.available || tail.lines.length === 0) return undefined;
                    return { source, lines: tail.lines.map((line) => line.message) };
                } catch (err) {
                    logger.warn("get_session_status recent-log tail failed", { extra: { source }, err });
                    return undefined;
                }
            }),
        );
        return tails.filter((tail): tail is RecentLogTail => tail != null);
    }

    /**
     * The linked project's READY deployments, or an empty list when Vercel could
     * not be reached.
     *
     * Listing deployments is a convenience on top of the connection state, and it
     * is the only part of it that depends on a third party being up and the
     * installation's token still being valid. Letting it throw turns a revoked
     * token or a Vercel blip into a hard failure of whatever tool asked - which,
     * on `link_vercel_project`, reports an already-committed link as an error and
     * strands the agent (its retry then hits "already linked"). So it degrades:
     * callers get the connection state either way, and `unavailable` is what they
     * tell the agent instead of pretending the project has no deployments.
     */
    async function tryListVercelDeployments(
        applicationId: string,
        organizationId: string,
    ): Promise<{ deployments: VercelDeploymentSummary[]; unavailable?: string }> {
        try {
            return { deployments: await services.onboarding.listVercelDeployments(applicationId, organizationId) };
        } catch (err) {
            logger.warn("Could not list Vercel deployments; returning the connection state without them", {
                applicationId,
                err,
            });
            return { deployments: [], unavailable: describeError(err) };
        }
    }

    /**
     * Which SDK-validation path a dry-run target needs.
     *
     * The Autonoma UI branches three ways here and so must this: a PreviewKit
     * preview is provisioned and discovered by us, a Vercel deployment is
     * discovered against the secret we adopted from the installation, and a
     * bring-your-own URL needs a signing secret only the user holds. Routing
     * everything through the managed path made the other two fail with "not
     * managed by PreviewKit" - a message that describes our dispatch rather than
     * anything the agent can act on.
     */
    async function resolveSdkValidationRoute(
        applicationId: string,
        organizationId: string,
        targetId: string,
    ): Promise<{ route: "managed" | "vercel" } | { route: "unsupported"; message: string }> {
        const { targets } = await services.onboarding.listSdkDryRunTargets(applicationId, organizationId);
        const target = targets.find((candidate) => candidate.id === targetId);
        if (target == null) {
            return {
                route: "unsupported",
                message:
                    `No SDK target "${targetId}". Call list_dry_run_targets and use one of the ids it returns - ` +
                    "they change as previews come and go, so do not reuse one from earlier in the session.",
            };
        }
        if (target.source === "vercel") return { route: "vercel" };
        // A BYO target's signing secret never passes through this MCP - there is no
        // tool that accepts a secret value - so this one genuinely has to be a
        // human action rather than a gap to fill later.
        if (target.source === "external") {
            return {
                route: "unsupported",
                message:
                    `SDK target "${targetId}" is a preview from the project's own pipeline, and validating it needs ` +
                    "the signing secret their pipeline signs with. Secret VALUES never pass through this MCP, so " +
                    "you cannot do this step: ask the user to validate this target in the Autonoma UI (the SDK " +
                    "step of finish setup), where they enter the secret themselves. Once it is validated, " +
                    "list_scenarios and dry_run_scenario work here as normal.",
            };
        }
        return { route: "managed" };
    }

    /**
     * The refusal a READ-ONLY bring-your-own-deploys tool returns on an
     * Autonoma-hosted app, or undefined to carry on. `guardedWrite`'s `requires`
     * covers the write tools; the read tools bypass it entirely, and a read that
     * answers happily is worse than a write that refuses - it hands the agent a
     * next step the write will then reject.
     */
    async function refuseIfAutonomaHosted(
        applicationId: string,
        organizationId: string,
        tool: string,
        useInstead: string,
    ): Promise<CallToolResult | undefined> {
        const mode = await services.onboarding.getPreviewEnvironmentMode(applicationId, organizationId);
        // Unset means undecided - let it through, same as the write guard, so an
        // agent can look before it commits to a path.
        if (mode !== "previewkit") return undefined;
        return wrongPathResult(tool, "existing_deploys", useInstead);
    }

    /**
     * How far along this app's Vercel connection is, used to pick which
     * bring-your-own-deploys playbook to hand over. DB-only (no Vercel API call),
     * so it is cheap enough to resolve on every pair / path decision.
     *
     * Best-effort: an app whose Vercel state cannot be read falls back to "not on
     * Vercel". That degrades to the webhook playbook, which is wrong but merely
     * more work - whereas failing here would break pairing, the one call that has
     * to succeed.
     */
    async function resolveVercelState(applicationId: string, organizationId: string): Promise<VercelState> {
        try {
            const projects = await services.onboarding.listAvailableVercelProjects(applicationId, organizationId);
            return { installed: projects.connected, linked: projects.linkedProject != null };
        } catch (err) {
            logger.warn("Could not resolve Vercel state; assuming this app is not on Vercel", { applicationId, err });
            return { installed: false, linked: false };
        }
    }

    /**
     * Best-effort: record which coding agent is driving from the MCP `clientInfo`
     * handshake, so the UI can name it ("Cursor is configuring...") instead of
     * assuming one. Undefined when the client did not report it (or the handshake
     * isn't on this request) - the UI then shows a neutral label. Never throws.
     */
    async function captureAgentClient(applicationId: string): Promise<void> {
        const name = server.server.getClientVersion()?.name;
        if (name == null || name.length === 0) return;
        try {
            await session.recordAgentClient(applicationId, name);
        } catch (err) {
            logger.warn("recordAgentClient failed", { applicationId, err });
        }
    }

    /**
     * Runs one agent write under the config mutex, streaming it as an activity
     * entry and recording an `mcp.tool_called` event. The steps are a deliberate
     * gated sequence, not parallelizable: authorize membership first (so a
     * non-member never mutates), then claim the mutex (standing down if the human
     * took over), then log-run-finish the work. Generic over the work's result so
     * the tool's payload stays fully typed.
     */
    async function guardedWrite<T>(
        { applicationId, tool, message, toolArguments, requires }: GuardedWriteParams,
        work: (organizationId: string) => Promise<T>,
    ): Promise<CallToolResult> {
        return analytics.track(tool, async () => {
            try {
                const organizationId = await resolveOrg(applicationId);
                if (requires != null) {
                    const mode = await services.onboarding.getPreviewEnvironmentMode(applicationId, organizationId);
                    // Unset means the user has not chosen yet - let it through rather
                    // than block an agent on a path that is still undecided.
                    if (mode != null && mode !== requires.source) {
                        // Only on the refusal path, so the happy path pays nothing for it.
                        const useInstead =
                            requires.useInsteadOnVercel != null &&
                            isVercelPath(await resolveVercelState(applicationId, organizationId))
                                ? requires.useInsteadOnVercel
                                : requires.useInstead;
                        return wrongPathResult(tool, requires.source, useInstead);
                    }
                }
                const claim = await session.claimForAgent(applicationId);
                if (!claim.claimed) return pausedResult();

                const eventId = await session.startLogEntry(applicationId, tool, message, toolArguments);
                try {
                    const result = await work(organizationId);
                    await session.finishLogEntry(applicationId, eventId, "done");
                    return jsonResult(result);
                } catch (err) {
                    await session.finishLogEntry(applicationId, eventId, "error", describeError(err));
                    throw err;
                }
            } catch (err) {
                logger.warn(`${tool} failed`, { applicationId, err });
                // A losing race is not a failure the agent should give up on - hand back the
                // merge inputs instead of an error string. Undefined for anything else.
                return recipeConflictResult(err) ?? toToolResult(err);
            }
        });
    }

    server.registerTool(
        "pair",
        {
            title: "Pair with an app",
            description:
                "Claim an app using the pairing code the user copied from the Autonoma UI. Returns the applicationId " +
                "(use it for every other tool), how the app gets its previews, and the playbook to follow - plus the " +
                "current config when Autonoma is the one building its previews.",
            inputSchema: { code: z.string().min(1) },
        },
        async ({ code }) =>
            analytics.track("pair", async () => {
                try {
                    logger.info("Pairing agent with code");
                    const view = await session.pairAgent(code, principal);
                    await captureAgentClient(view.applicationId);
                    const organizationId = await resolveOrg(view.applicationId);
                    const mode = view.previewEnvironmentMode;
                    // Which repo this app is. Without it an agent has no way to tell it
                    // is sitting in the wrong checkout, and everything it infers from
                    // the wrong codebase - not least which preview path to pick - is
                    // confidently wrong. Best-effort: a GitHub hiccup must not fail
                    // pairing, which is the one call that has to succeed.
                    //
                    // Fetched alongside the config, not before it: the GitHub round-trip
                    // and the config read share only their inputs, so awaiting them in
                    // sequence made every previewkit pair pay for both. Only Autonoma-hosted
                    // previews have a config worth reading - on the customer's own pipeline
                    // there is none, and before a path is picked there is only a default,
                    // and handing either over invites the agent to start "fixing" a
                    // document instead of doing the actual next thing.
                    const [repository, config, vercel] = await Promise.all([
                        services.github.getApplicationRepository(organizationId, view.applicationId).catch((err) => {
                            logger.warn("pair could not resolve the app repository", {
                                applicationId: view.applicationId,
                                err,
                            });
                            return null;
                        }),
                        mode === "previewkit"
                            ? services.onboarding.getPreviewkitConfig(view.applicationId, organizationId)
                            : undefined,
                        resolveVercelState(view.applicationId, organizationId),
                    ]);
                    const repoFields = {
                        repository: repository?.fullName,
                        checkRepository:
                            repository?.fullName == null
                                ? "Could not resolve this app's repository. Confirm with the user which repo it is before analyzing anything."
                                : `Before you analyze anything, confirm the repo you are in IS ${repository.fullName} (e.g. \`git remote get-url origin\`). If it is not, STOP and tell the user - conclusions drawn from the wrong repo will be wrong.`,
                    };
                    if (config == null) {
                        return jsonResult({
                            paired: true,
                            applicationId: view.applicationId,
                            previewSource: previewSourceOf(mode),
                            vercel: describeVercelState(vercel, mode),
                            step: view.step,
                            ...repoFields,
                            playbook: playbookFor(mode, vercel),
                        });
                    }
                    return jsonResult({
                        paired: true,
                        applicationId: view.applicationId,
                        previewSource: previewSourceOf(mode),
                        vercel: describeVercelState(vercel, mode),
                        step: view.step,
                        ...repoFields,
                        playbook: playbookFor(mode, vercel),
                        currentConfig: config.document,
                        configExists: config.saved,
                        deployBranch: config.deployBranch,
                        deprecatedBuilds: deprecatedBuildNotice(config.document),
                    });
                } catch (err) {
                    logger.warn("pair failed", { err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "get_github_connection",
        {
            title: "Check the GitHub connection",
            description:
                "Whether Autonoma can see this app's repository yet, and which repositories are available to link. " +
                "Safe to call at any point: if you were handed a pairing code from the Autonoma UI the repository is " +
                "already connected, and this just confirms which one - worth checking against your working directory " +
                "before you read any files. If the GitHub App is not installed, this returns a link to hand to a human " +
                "and polls to completion - GitHub has no API to install an app, so it is the one step an agent cannot " +
                "do itself.",
            inputSchema: { applicationId: z.string() },
        },
        async ({ applicationId }) =>
            analytics.track("get_github_connection", async () => {
                try {
                    const organizationId = await resolveOrg(applicationId);
                    const installation = await services.github.getInstallation(organizationId);
                    if (installation == null) {
                        const slug = services.github.getSlug();
                        const state = createInstallState(organizationId);
                        return jsonResult(
                            needsHuman({
                                action: "install_github_app",
                                reason:
                                    "Autonoma's GitHub App is not installed on this organization. GitHub only allows " +
                                    "an organization owner to install it, from their browser.",
                                url: `https://github.com/apps/${slug}/installations/new?state=${state}`,
                                pollWith: "get_github_connection",
                                expiresAt: new Date(Date.now() + INSTALL_STATE_TTL_MS),
                            }),
                        );
                    }

                    const repositories = await services.github.listRepositories(organizationId);
                    const linked = repositories.find((repo) => repo.applicationId === applicationId);
                    return jsonResult({
                        connected: true,
                        account: installation.accountLogin,
                        linkedRepository: linked?.fullName,
                        // Only repos the installation can see are linkable. Granting access to more is
                        // also a browser step, hence the settings link rather than a tool.
                        availableRepositories: repositories
                            .filter((repo) => repo.applicationId == null)
                            .map((repo) => repo.fullName),
                        grantAccessToMoreUrl: `https://github.com/apps/${services.github.getSlug()}/installations/new`,
                    });
                } catch (err) {
                    logger.warn("get_github_connection failed", { applicationId, err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "link_repository",
        {
            title: "Link a repository to this app",
            description:
                "Connect this app to one of the repositories Autonoma can see, for an app that has none yet, and " +
                "complete the GitHub step. Only for an app being set up entirely through this MCP - if the app " +
                "already has a repository (which it does whenever the pairing code came from the Autonoma UI) this " +
                "refuses rather than moving it, since that would repoint an app people are already using. Changing " +
                "an existing link is a UI action. Call get_github_connection first for the available names, and use " +
                "the full 'owner/repo' form.",
            inputSchema: { applicationId: z.string(), repoFullName: z.string().min(1) },
        },
        async ({ applicationId, repoFullName }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "link_repository",
                    message: `Linked ${repoFullName}`,
                    toolArguments: { repoFullName },
                },
                async (organizationId) => {
                    const repositories = await services.github.listRepositories(organizationId);
                    // `linkRepository` deliberately supports re-linking, so nothing below would stop an
                    // agent repointing a connected app at a different repository. On every path that
                    // starts in the UI the app is already linked before an agent can pair, so that is
                    // the common case, not the edge one.
                    const alreadyLinked = repositories.find((repo) => repo.applicationId === applicationId);
                    if (alreadyLinked != null) {
                        if (alreadyLinked.fullName === repoFullName) {
                            return { linkedRepository: alreadyLinked.fullName, alreadyLinked: true };
                        }
                        throw new ConflictError(
                            `This app is already linked to ${alreadyLinked.fullName}. Changing which repository an app points at is a UI action, since it repoints work people may already be relying on.`,
                        );
                    }

                    const match = repositories.find((repo) => repo.fullName === repoFullName);
                    if (match == null) {
                        throw new NotFoundError(
                            `${repoFullName} is not one of the repositories Autonoma can see. Call get_github_connection for the available names, or grant access to it on GitHub first.`,
                        );
                    }

                    await services.github.linkRepository(organizationId, applicationId, match.id);
                    // Linking is what the GitHub step was waiting on, so advance it here rather than
                    // leaving the agent to discover a separate completion tool. Mirrors the UI.
                    await services.onboarding.completeGithub(applicationId, organizationId);
                    return { linkedRepository: match.fullName, step: "preview_environment" };
                },
            ),
    );

    server.registerTool(
        "select_preview_path",
        {
            title: "Choose how this app gets its previews",
            description:
                "Commit how this app will get its previews, when pair() reported `not-chosen-yet`. FIRST confirm your " +
                "working directory is the repo pair() named in `repository` - a path picked from the wrong " +
                "checkout is worse than no answer. Then decide from the " +
                "REPO, not from asking the user to self-assess: whether previews already exist (a deploy workflow, a " +
                "host config, preview URLs on past pull requests) and whether every table hangs off a tenant you " +
                "could delete whole. Prefer `autonoma-hosted` when there are no previews, or when data is not cleanly " +
                "tenant-scoped - an Autonoma-hosted preview gets its own database, so a run cannot leave rows behind " +
                "in whatever staging or production database their existing previews point at. Prefer " +
                "`their-pipeline` when previews already exist AND the data is tenant-scoped, since that is far less " +
                "to change. Deploying on Vercel does NOT by itself decide this - the data-isolation trade-off above " +
                "does. A Vercel project is a perfectly normal `autonoma-hosted` app, and people choose that " +
                "deliberately for the per-preview database; pick `their-pipeline` only if the same tenant-scoping " +
                "test passes. If you do pick `their-pipeline` for a Vercel project, the playbook that comes back " +
                "names the Vercel tools rather than the webhook. Say WHY in " +
                "`reason` - the user is watching, and this is a decision they would otherwise " +
                "have answered a questionnaire to make. Returns the playbook for the path you chose; follow it next.",
            inputSchema: {
                applicationId: z.string(),
                path: z
                    .enum(["autonoma-hosted", "their-pipeline"])
                    .describe("`autonoma-hosted` = Autonoma builds the previews; `their-pipeline` = the project does."),
                reason: z
                    .string()
                    .min(1)
                    .max(ACTIVITY_DESCRIPTION_MAX_LENGTH)
                    .describe("Why this path, in one line, from what you found in the repo. Shown to the user."),
            },
        },
        async ({ applicationId, path, reason }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "select_preview_path",
                    message: reason,
                    toolArguments: { path },
                },
                async (org) => {
                    const mode: OnboardingPreviewEnvironmentMode =
                        path === "autonoma-hosted" ? "previewkit" : "existing_deploys";
                    // Independent: the Vercel state is the org's installation and this
                    // app's project link, none of which the mode write touches.
                    const [, vercel] = await Promise.all([
                        services.onboarding.selectPreviewEnvironmentMode(applicationId, org, mode),
                        resolveVercelState(applicationId, org),
                    ]);
                    return {
                        previewSource: previewSourceOf(mode),
                        playbook: playbookFor(mode, vercel),
                        message:
                            "Path chosen. Follow the playbook above - and tell the user which you picked and why, " +
                            "since they can still change it in the Autonoma UI.",
                    };
                },
            ),
    );

    server.registerTool(
        "apply_config",
        {
            title: "Save the preview config",
            description:
                "Save the FULL preview config document (read it with get_config first, edit it, send the whole " +
                "document back). Validated on save; an invalid document returns the errors to fix. Never include " +
                "secret values - declare secret keys as build_secrets and set their values via request_env. " +
                "An app's `build` is either `runtime` (pick a language runtime, write a bash build_script and a " +
                "single-line entrypoint) or `dockerfile` (build a Dockerfile committed in the repo) - those are the " +
                "only two methods, and the only two the user can edit in the Autonoma UI. If get_config handed you a " +
                "document whose app still uses an older framework preset, convert it to `runtime` before saving. " +
                "Services do not auto-inject env into apps: wire each app to the databases/services it uses via " +
                "connections, e.g. { key: 'DATABASE_URL', value: '{{db.url}}' } ({{name.property}} tokens resolve " +
                "at deploy time; {{service.url}} is the full connection string). " +
                "Mark the app that serves the Autonoma SDK handler (`/api/autonoma`) with `sdk_implemented: true` - " +
                "scenario up/down goes to that app's URL. Exactly one app; independent of `primary`, so a full-stack " +
                "app sets both, while a split front/API topology marks the frontend `primary` and the API " +
                "`sdk_implemented`. " +
                "Optionally pass `branch` to set which branch the base preview (environment 0) deploys from. If unset it uses the " +
                "repo's default branch (whatever it is named) - don't steer toward a branch name without cause. Set it " +
                "when the user is working on a different branch (check their checkout's current branch and ask which " +
                "to use). Validated against GitHub, so a typo is rejected. " +
                "Setting the branch here does NOT deploy - trigger_deploy does. " +
                "Pass a short `description` of what this save does - the user watches it on the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                document: authoringPreviewConfigSchema,
                branch: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "Branch the base preview (environment 0) deploys from. Omit to use the repo's default branch; set it " +
                            "when the user is working on a different branch (ask them which to use).",
                    ),
                description: activityDescription,
            },
        },
        async ({ applicationId, document, branch, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "apply_config",
                    requires: {
                        source: "previewkit",
                        useInstead: "get_signal_setup",
                        useInsteadOnVercel: "get_vercel_setup",
                    },
                    message: description ?? "Saving preview config",
                    toolArguments:
                        branch != null ? { apps: document.apps.length, branch } : { apps: document.apps.length },
                },
                async (org) => {
                    const saved = await services.onboarding.savePreviewkitConfig(applicationId, org, document);
                    if (branch == null) return saved;
                    const { branch: deployBranch } = await services.onboarding.setDeployBranch(
                        applicationId,
                        org,
                        branch,
                    );
                    return { ...saved, deployBranch };
                },
            ),
    );

    server.registerTool(
        "request_env",
        {
            title: "Ask the user for env values",
            description:
                "Ask the user to enter secret env VALUES in the Autonoma UI (you never see them). Pass only the KEYS " +
                "you need and the appName they belong to (secret stores are per-app; read it from get_config). ALWAYS " +
                "ask the user first whether to fill from their .env (default) or set them manually. Then poll " +
                "get_session_status until the pending request clears - wait ~30s between polls and keep going for as " +
                "long as it takes. That poll is the only thing that tells you the values landed, so do not stop and " +
                "wait to be told. AUTONOMA_* variables are injected automatically and are " +
                "rejected. Pass a short `description` of what you're requesting and why - the user watches it on " +
                "the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                keys: z.array(z.string().min(1)).min(1),
                appName: z.string().min(1),
                note: z.string().optional(),
                description: activityDescription,
            },
        },
        async ({ applicationId, keys, appName, note, description }) => {
            // Reject Autonoma-provided keys BEFORE raising the request: the UI's value
            // submission hard-rejects them, so a request containing one is unanswerable -
            // the user would be stuck staring at a form they can never satisfy. Failing
            // here instead lets the agent drop the keys and re-request only what's real.
            const protectedKeys = keys.filter(isProtectedPreviewkitEnvKey);
            if (protectedKeys.length > 0) {
                return errorResult(
                    `Refusing to request ${protectedKeys.join(", ")}: Autonoma injects these automatically into ` +
                        "every preview app and the user cannot set them. Remove them and request only the app's " +
                        "own secrets (third-party API keys, tokens). A preview-internal service URL is not a user " +
                        "secret either - wire it as a connection in apply_config.",
                );
            }
            return guardedWrite(
                {
                    applicationId,
                    tool: "request_env",
                    requires: {
                        source: "previewkit",
                        useInstead: "their own pipeline's secret store",
                        useInsteadOnVercel: "the project's own environment variables in Vercel",
                    },
                    message: description ?? `Requesting ${keys.length} env value(s) from the user`,
                    toolArguments: { keys, appName },
                },
                async () => {
                    await session.raisePendingRequest(applicationId, { kind: "env", keys, appName, note });
                    return {
                        status: "input_requested",
                        message:
                            "Asked the user to provide these values in the Autonoma UI. Now poll get_session_status " +
                            "until pendingRequest is cleared, which is when they are set: wait ~30s between polls " +
                            "and keep polling for as long as it takes (finding a key can take a user many minutes). " +
                            "That poll is your only signal - a quiet chat tells you nothing, so do not stop and " +
                            "wait to be told; if the user does say here that they are done, poll once to pick it " +
                            "up. The user can SKIP keys they don't have - check lastEnvResolution.skippedKeys and " +
                            "adapt the config (default it, drop it, or rework the approach) instead of " +
                            "re-requesting the same key. Do NOT ask for or send the values yourself.",
                    };
                },
            );
        },
    );

    server.registerTool(
        "trigger_deploy",
        {
            title: "Deploy the preview",
            description:
                "Deploy the app's configured deploy branch as the base preview (environment 0), applying the " +
                "saved config. If unset the deploy branch is the repo's default branch - but if the user's checkout is " +
                "on a different branch, ask which to use and set it with apply_config's `branch` field before deploying, " +
                "rather than steering to the default. Then poll get_session_status until it is up, and verify the preview " +
                "URL yourself. Pass a short `description` of what you are deploying - the user watches it on the activity feed.",
            inputSchema: { applicationId: z.string(), description: activityDescription },
        },
        async ({ applicationId, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "trigger_deploy",
                    requires: {
                        source: "previewkit",
                        useInstead: "get_signal_status (their pipeline does the deploying)",
                        useInsteadOnVercel:
                            "create_vercel_deployment / select_vercel_deployment (Vercel does the deploying)",
                    },
                    message: description ?? "Deploying preview (default branch)",
                    toolArguments: {},
                },
                (org) => services.onboarding.triggerPreviewkitMainDeploy(applicationId, org),
            ),
    );

    server.registerTool(
        "get_session_status",
        {
            title: "Poll status",
            description:
                "The single polling tool: returns your control state, any pending user request, the deploy status, " +
                "the preview URL, diagnostics, and `recentLogs` - a tail of the build logs while building (or both " +
                "build and app logs on failure) so you can see WHY a deploy failed and fix it, not just that it did. " +
                "Poll this to wait for a build to finish AND to wait for the user to answer a request - while a " +
                "request is pending, keep polling (roughly every 30s, for as long as it takes) instead of stopping " +
                "and waiting to be told; this call is the only thing that reports the values landed. When an env " +
                "request resolves, `lastEnvResolution` tells you which keys were set and which the user SKIPPED " +
                "(doesn't have) - adapt to skipped keys instead of re-requesting them. When diagnostics.status is " +
                "`failed`, read recentLogs for the failing step, fix the config or ask the user for a missing " +
                "secret, then redeploy. When status is `ready`, recentLogs carries the app's RUNTIME logs: exercise " +
                "the main flow against the preview URL, then read them - a passing health check does not mean the " +
                "app works, and erroring logs behind a ready status mean you are not done. " +
                "If it reports standDown, the user took over - stop configuring.",
            inputSchema: { applicationId: z.string() },
        },
        async ({ applicationId }) =>
            analytics.track("get_session_status", async () => {
                try {
                    const organizationId = await resolveOrg(applicationId);
                    // Capture the client on a polled call too, in case the pair request
                    // didn't carry the handshake. No-op once the client is already known.
                    await captureAgentClient(applicationId);
                    // Beat the heartbeat first so the freshly-read view reflects it, then
                    // fetch the view and the deploy readiness together - independent reads.
                    await session.heartbeatIfAgentHeld(applicationId);
                    const [view, readiness] = await Promise.all([
                        session.getForUi(applicationId),
                        services.onboarding.getPreviewReadiness(applicationId, organizationId),
                    ]);
                    // Needs readiness.diagnostics (status + the log-stream handle), so it
                    // can't join the parallel read above.
                    const recentLogs = await tailPhaseLogs(organizationId, readiness.diagnostics);
                    return jsonResult({
                        standDown: view?.holder === "human",
                        holder: view?.holder,
                        pendingRequest: view?.pendingRequest,
                        pendingRequestMessage: describePendingRequest(view?.pendingRequest),
                        lastEnvResolution: view?.lastEnvResolution,
                        previewVerificationStatus: view?.previewVerificationStatus,
                        step: view?.step,
                        previewUrl: readiness.previewUrl,
                        diagnostics: readiness.diagnostics,
                        recentLogs,
                    });
                } catch (err) {
                    logger.warn("get_session_status failed", { applicationId, err });
                    return toToolResult(err);
                }
            }),
    );

    // ─── existing_deploys path, on Vercel: connecting the Marketplace integration ────

    server.registerTool(
        "get_vercel_setup",
        {
            title: "Read the Vercel connection state",
            description:
                "For apps that deploy on Vercel: how far the Autonoma Vercel integration has got, and what to do " +
                "next. Returns whether the ORG has the integration installed, the projects that can be linked to " +
                "this app, the project already linked, and - once one is - that project's READY deployments to " +
                "choose a preview from. This is the Vercel equivalent of get_signal_setup: on Vercel there is no " +
                "webhook to write, because the integration already reports every deployment. Read `nextStep`, which " +
                "names the exact call to make from here.",
            inputSchema: { applicationId: z.string() },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ applicationId }) =>
            analytics.track("get_vercel_setup", async () => {
                try {
                    const organizationId = await resolveOrg(applicationId);
                    // Read-only, so it never reaches guardedWrite's path check - and
                    // without this it would hand an Autonoma-hosted app a `nextStep`
                    // telling it to link a project, which the write tools then refuse.
                    // Being on Vercel and choosing Autonoma-hosted previews is a normal
                    // combination (people pick it for the per-preview database), so this
                    // has to read as "wrong tool", not "something is misconfigured".
                    const refusal = await refuseIfAutonomaHosted(
                        applicationId,
                        organizationId,
                        "get_vercel_setup",
                        "get_config / apply_config / trigger_deploy",
                    );
                    if (refusal != null) return refusal;
                    const projects = await services.onboarding.listAvailableVercelProjects(
                        applicationId,
                        organizationId,
                    );
                    // Only worth a Vercel API round-trip once a project is linked -
                    // unlinked, there is no project whose deployments we could list.
                    const { deployments, unavailable } =
                        projects.linkedProject != null
                            ? await tryListVercelDeployments(applicationId, organizationId)
                            : { deployments: [], unavailable: undefined };
                    return jsonResult({
                        installed: projects.connected,
                        connectUrl: projects.connectUrl,
                        // Explicit rather than omitted-when-absent: an agent reading a
                        // missing key cannot tell "not linked" from "field not returned".
                        projectLinked: projects.linkedProject != null,
                        linkedProject: projects.linkedProject,
                        linkableProjects: projects.projects,
                        deployments,
                        deploymentsUnavailable: unavailable,
                        nextStep: describeVercelNextStep(projects, deployments.length, unavailable),
                    });
                } catch (err) {
                    logger.warn("get_vercel_setup failed", { applicationId, err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "link_vercel_project",
        {
            title: "Link a Vercel project to this app",
            description:
                "Link one of the Vercel projects from get_vercel_setup's `linkableProjects` to this app. Choose the " +
                "candidate whose `matchesRepository` is true - it builds the same GitHub repo the app is linked to. " +
                "If none matches, ASK the user which project it is rather than guessing from the name; linking the " +
                "wrong project points Autonoma's tests at someone else's app. This is the step that makes everything " +
                "else work: it applies the deployment-protection bypass header (without which Autonoma cannot reach " +
                "a protected preview at all) and adopts the AUTONOMA_SHARED_SECRET Vercel already injected into the " +
                "project, so the SDK handler's signature matches what Autonoma verifies. Reversible - the user can " +
                "unlink in the Autonoma UI. Pass a short `description`; the user watches it on the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                vercelProjectId: z
                    .string()
                    .min(1)
                    .describe("A project `id` from get_vercel_setup's `linkableProjects`."),
                description: activityDescription,
            },
        },
        async ({ applicationId, vercelProjectId, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "link_vercel_project",
                    requires: { source: "existing_deploys", useInstead: "apply_config / trigger_deploy" },
                    message: description ?? "Linking the Vercel project",
                    toolArguments: { vercelProjectId },
                },
                async (org) => {
                    await services.onboarding.linkVercelProject(applicationId, org, vercelProjectId);
                    // Best-effort: the link is already committed, so a Vercel hiccup
                    // here must not report it as a failure - the agent would retry and
                    // hit "already linked", with no way to tell that it had won.
                    const { deployments, unavailable } = await tryListVercelDeployments(applicationId, org);
                    return {
                        linked: true,
                        deployments,
                        deploymentsUnavailable: unavailable,
                        message:
                            unavailable != null
                                ? "Linked - that part is done and does not need repeating. Autonoma could not " +
                                  "reach Vercel to list this project's deployments, so continue with " +
                                  "get_vercel_setup once Vercel is reachable; do NOT call link_vercel_project again."
                                : "Linked. Vercel now reports this project's deployments to Autonoma, and protected " +
                                  "previews are reachable. Next: pick a deployment from `deployments` and call " +
                                  "create_vercel_deployment on it, so it rebuilds with the project's current env.",
                    };
                },
            ),
    );

    server.registerTool(
        "create_vercel_deployment",
        {
            title: "Create a Vercel deployment",
            description:
                "Rebuild an EXISTING Vercel deployment so it picks up the injected AUTONOMA_SHARED_SECRET, then " +
                "use it as the preview Autonoma tests against. Only for reusing an old deployment. You usually do " +
                "not need this: pushing the branch you are about to write the SDK handler on makes Vercel build a " +
                "preview for it, and a fresh build already carries the secret - select that one directly instead. " +
                "This really deploys: it CREATES a new deployment, a live build on their Vercel account, billable " +
                "to them, reachable at a new URL, and it cannot be undone from here. Never call it to 'refresh' " +
                "anything. " +
                "Do not choose the source deployment yourself - ask the user which of get_vercel_setup's " +
                "`deployments` to use, the same question the Autonoma UI asks over the same list. Never pick a " +
                "`target: production` one on your own initiative: rebuilding it deploys their LIVE site, and what " +
                "you select becomes the target of every scenario run, pointing test-data creation and teardown at " +
                "their live database. " +
                "The new deployment has its own " +
                "id and URL, so poll and select THAT id, not the one you passed " +
                "in. It only starts the build; poll get_vercel_deployment_status until ready, then call " +
                "select_vercel_deployment. Pass a short `description`; the user watches it on the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                vercelDeploymentId: z
                    .string()
                    .min(1)
                    .describe("A deployment `id` from get_vercel_setup's `deployments`."),
                description: activityDescription,
            },
        },
        async ({ applicationId, vercelDeploymentId, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "create_vercel_deployment",
                    requires: { source: "existing_deploys", useInstead: "trigger_deploy" },
                    message: description ?? "Deploying a fresh Vercel build to test against",
                    toolArguments: { vercelDeploymentId },
                },
                async (org) => {
                    const result = await services.onboarding.redeployVercelDeployment(
                        applicationId,
                        org,
                        vercelDeploymentId,
                    );
                    return {
                        deploymentId: result.deploymentId,
                        url: result.url,
                        readyState: result.readyState,
                        message:
                            `Building as a NEW deployment (${result.deploymentId}) - the id you passed in is not ` +
                            "the one to continue with. Poll get_vercel_deployment_status with this new id every " +
                            "~30s until `ready` is true (a Vercel build takes minutes), then call " +
                            "select_vercel_deployment with it.",
                    };
                },
            ),
    );

    server.registerTool(
        "get_vercel_deployment_status",
        {
            title: "Poll a Vercel build",
            description:
                "Build state of one Vercel deployment, for waiting out a redeploy. `ready` is true once Vercel " +
                "reports READY; `readyState` carries Vercel's own string (QUEUED / BUILDING / READY / ERROR / " +
                "CANCELED) so an errored build is distinguishable from one still going. Poll ~30s apart and keep " +
                "going - nothing else will tell you the build finished. On ERROR or CANCELED, stop polling and read " +
                "the build output in Vercel's dashboard: Vercel builds these, so Autonoma holds no logs for them.",
            inputSchema: {
                applicationId: z.string(),
                vercelDeploymentId: z
                    .string()
                    .min(1)
                    .describe("The NEW deployment id returned by create_vercel_deployment."),
            },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ applicationId, vercelDeploymentId }) =>
            analytics.track("get_vercel_deployment_status", async () => {
                try {
                    const organizationId = await resolveOrg(applicationId);
                    const refusal = await refuseIfAutonomaHosted(
                        applicationId,
                        organizationId,
                        "get_vercel_deployment_status",
                        "get_session_status",
                    );
                    if (refusal != null) return refusal;
                    const status = await services.onboarding.getVercelDeploymentStatus(
                        applicationId,
                        organizationId,
                        vercelDeploymentId,
                    );
                    return jsonResult({
                        readyState: status.readyState,
                        ready: status.ready,
                        url: status.url,
                        nextStep: describeVercelBuildNextStep(status.ready, status.readyState),
                    });
                } catch (err) {
                    logger.warn("get_vercel_deployment_status failed", { applicationId, err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "select_vercel_deployment",
        {
            title: "Use a Vercel deployment as the preview",
            description:
                "Commit a READY Vercel deployment as the preview Autonoma tests against. Pass the id " +
                "create_vercel_deployment returned, once get_vercel_deployment_status reports `ready`; a " +
                "still-building deployment is rejected. Know what this commits: every scenario run creates and " +
                "deletes rows through this deployment, in whatever database it talks to - so never commit a " +
                "`production` deployment without the user having explicitly agreed to it. This advances " +
                "onboarding on its own - on Vercel there is no " +
                "confirm_signal_setup and no signal to wait for, because the integration reports deployments " +
                "already. Pass a short `description`; the user watches it on the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                vercelDeploymentId: z.string().min(1).describe("A READY deployment id."),
                description: activityDescription,
            },
        },
        async ({ applicationId, vercelDeploymentId, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "select_vercel_deployment",
                    requires: { source: "existing_deploys", useInstead: "trigger_deploy" },
                    message: description ?? "Selecting the Vercel preview",
                    toolArguments: { vercelDeploymentId },
                },
                async (org) => {
                    await services.onboarding.selectVercelDeployment(applicationId, org, vercelDeploymentId);
                    const status = await services.onboarding.getExternalSignalStatus(applicationId, org);
                    return {
                        previewUrl: status.previewUrl,
                        step: status.step,
                        message:
                            "This deployment is now the preview Autonoma tests against. Onboarding has advanced - " +
                            "no confirm step is needed here. Next: the Autonoma SDK handler and the scenario " +
                            "recipes; list_dry_run_targets lists this project's Vercel deployments as targets.",
                    };
                },
            ),
    );

    // ─── existing_deploys path: wiring the customer's own pipeline ────

    server.registerTool(
        "get_signal_setup",
        {
            title: "Read the deployment-signal contract",
            description:
                "For apps whose previews come from their own pipeline: everything needed to make that pipeline tell " +
                "Autonoma a preview is live - the endpoint, the applicationId, the shared secret to sign with, every " +
                "body field, and a starter GitHub Actions workflow. The workflow is a TEMPLATE, not a requirement: it " +
                "hangs off GitHub's `deployment_status` event, which many pipelines never emit. Read how the project " +
                "actually deploys and make the same signed call from whatever step knows a preview is live. Send " +
                "`branch` and `prNumber` together to get per-PR reviews - one without the other is dropped. NOT for " +
                "projects on Vercel: the Autonoma Vercel integration reports deployments already, so use " +
                "get_vercel_setup there instead.",
            inputSchema: { applicationId: z.string() },
        },
        async ({ applicationId }) =>
            analytics.track("get_signal_setup", async () => {
                try {
                    const organizationId = await resolveOrg(applicationId);
                    const [status, secret, vercel] = await Promise.all([
                        services.onboarding.getExternalSignalStatus(applicationId, organizationId),
                        services.applications.getSharedSecret(applicationId, organizationId),
                        resolveVercelState(applicationId, organizationId),
                    ]);
                    if (status.previewEnvironmentMode === "previewkit") {
                        return errorResult(
                            "This app uses Autonoma-hosted previews - Autonoma builds them, so there is no signal for a " +
                                "pipeline to send. Use get_config / apply_config / trigger_deploy instead.",
                        );
                    }
                    // A linked Vercel project settles it: the integration reports every
                    // deployment already, so a hand-written signal would be a second,
                    // worse path - and would not fix reaching a protected preview, which
                    // only the link does. Refused rather than warned, because the secret
                    // handed over below is exactly the trap: it looks right, and fails at
                    // runtime against the one Vercel injected into their project.
                    if (vercel.linked) {
                        return errorResult(
                            "This app has a Vercel project linked, so Vercel already tells Autonoma about every " +
                                "deployment - there is no webhook to write here, and writing one would not make a " +
                                "protection-enabled preview reachable. Use get_vercel_setup instead.",
                        );
                    }
                    return jsonResult({
                        // Not a refusal: an org can run the Vercel integration for other
                        // projects and still deploy THIS app somewhere else. But an agent
                        // that lands here by default would build a webhook the integration
                        // was going to make unnecessary, so say so before it starts.
                        vercelNotice: vercel.installed
                            ? "This org has the Autonoma Vercel integration installed, but no Vercel project is " +
                              "linked to this app. If this project deploys on Vercel, STOP and use get_vercel_setup " +
                              "- linking is what makes protected previews reachable, and no webhook substitutes " +
                              "for it. Continue here only if this app genuinely deploys somewhere else."
                            : undefined,
                        endpoint: signalEndpoint(),
                        applicationId,
                        sharedSecret: secret.sharedSecret,
                        signature: {
                            header: "x-signature",
                            algorithm: "HMAC-SHA256, hex digest",
                            signedOver:
                                "The exact raw request body bytes. Re-serializing the JSON after signing changes " +
                                "the digest and the call is rejected.",
                        },
                        body: DEPLOYMENT_SIGNAL_BODY_FIELDS,
                        templateWorkflow: buildDeploymentSignalWorkflow({ applicationId, endpoint: signalEndpoint() }),
                        templateWorkflowNote:
                            "A starting point for pipelines that report deployments to GitHub. If this project " +
                            "does not emit deployment_status, do not bend it to fit - make the same signed call " +
                            "from whatever step in its pipeline knows a preview is live.",
                    });
                } catch (err) {
                    logger.warn("get_signal_setup failed", { applicationId, err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "get_signal_status",
        {
            title: "Check whether a deployment signal has landed",
            description:
                "For apps whose previews come from their own pipeline: whether Autonoma has received a signed signal, the preview " +
                "URL it carried, and whether any signal has ever carried a prNumber (`prReviewsConfirmed`) - which is " +
                "what per-PR reviews require. This is the ONLY confirmation the wiring works, so poll it after " +
                "triggering a real deploy. Prove it with an actual pipeline run rather than a hand-written curl: a " +
                "curl proves your curl works, not that their pipeline calls us.",
            inputSchema: { applicationId: z.string() },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ applicationId }) =>
            analytics.track("get_signal_status", async () => {
                try {
                    const organizationId = await resolveOrg(applicationId);
                    const [status, vercel] = await Promise.all([
                        services.onboarding.getExternalSignalStatus(applicationId, organizationId),
                        resolveVercelState(applicationId, organizationId),
                    ]);
                    // On Vercel nobody sends a signal, so `signalReceived: false` is the
                    // steady state rather than a problem. Left unqualified it reads as
                    // broken wiring and sends the agent off to fix a webhook that should
                    // not exist.
                    if (isVercelPath(vercel)) {
                        return jsonResult({
                            previewSource: previewSourceOf(status.previewEnvironmentMode),
                            step: status.step,
                            previewUrl: status.previewUrl,
                            nextStep:
                                "This app is on Vercel, where the Marketplace integration reports deployments " +
                                "directly - no pipeline sends a signal here, so signal status does not apply and " +
                                "its absence is not a fault. Use get_vercel_setup for the real state of this path.",
                        });
                    }
                    // Projected field by field rather than spread: the row carries the
                    // internal `previewEnvironmentMode` enum, and an agent that sees a
                    // value repeats it to the user.
                    return jsonResult({
                        previewSource: previewSourceOf(status.previewEnvironmentMode),
                        step: status.step,
                        signalReceived: status.signalReceived,
                        previewUrl: status.previewUrl,
                        prReviewsConfirmed: status.prReviewsConfirmed,
                        prReviewsConfirmedAt: status.prReviewsConfirmedAt,
                        nextStep: describeSignalNextStep(status),
                    });
                } catch (err) {
                    logger.warn("get_signal_status failed", { applicationId, err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "confirm_signal_setup",
        {
            title: "Mark the deploy-signal wiring as done",
            description:
                "For apps whose previews come from their own pipeline: mark the wiring finished so onboarding advances from " +
                "configuring to waiting for signals. Call it once you have SEEN a signal land via get_signal_status - " +
                "confirming before then just moves the UI on while the wiring is still broken. Pass a short " +
                "`description` - the user watches it on the activity feed.",
            inputSchema: { applicationId: z.string(), description: activityDescription },
        },
        async ({ applicationId, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "confirm_signal_setup",
                    message: description ?? "Confirming the deploy-signal wiring",
                    toolArguments: {},
                    requires: { source: "existing_deploys", useInstead: "trigger_deploy" },
                },
                async (org) => {
                    // On Vercel there is nothing to confirm: select_vercel_deployment
                    // already advanced the app to preview_verified, and that state does
                    // not implement this transition - so the call would fail with a state
                    // mismatch rather than telling the agent it had already finished. The
                    // Autonoma UI skips this step for Vercel for the same reason.
                    if (isVercelPath(await resolveVercelState(applicationId, org))) {
                        throw new ConflictError(
                            "Nothing to confirm on Vercel: the integration reports deployments itself, and " +
                                "select_vercel_deployment already advanced onboarding. If you have selected a " +
                                "deployment, this step is done - carry on with the SDK handler and the scenario " +
                                "recipes.",
                        );
                    }
                    await services.onboarding.confirmExistingDeploysSetup(applicationId, org);
                    const status = await services.onboarding.getExternalSignalStatus(applicationId, org);
                    return {
                        step: status.step,
                        signalReceived: status.signalReceived,
                        prReviewsConfirmed: status.prReviewsConfirmed,
                    };
                },
            ),
    );

    server.registerTool(
        "get_target_logs",
        {
            title: "Read a preview target's logs",
            description:
                "Build or runtime log lines for ONE preview environment, named by a target `id` from " +
                "list_dry_run_targets. get_session_status only ever reports the BASE preview (environment 0), so " +
                "this is how you see a PR preview - the one carrying the app's SDK handler - when its validate or " +
                "dry run fails. Pick `source`: 'build' for a preview that never came up, 'app' for one that " +
                "deployed but errors when Autonoma calls it (an SDK handler that throws lands here). Previews are " +
                "multi-service; omit `app` for all services (the result's `services` lists which produced output) " +
                "or pass one name to narrow. `from` picks the window - 'tail' (newest, default) for a failure, " +
                "'head' for startup - and `filter` is a case-insensitive substring pre-filter. Empty `lines` with " +
                "`available: true` means the window genuinely had no output. Logs persist ~30 days and outlive the " +
                "environment, so they still answer 'why did that preview fail' after it is torn down.",
            inputSchema: {
                applicationId: z.string(),
                target: z
                    .string()
                    .describe("A target `id` from list_dry_run_targets - the preview whose logs you want."),
                source: z
                    .enum(["build", "app"])
                    .describe("'build' for the image build, 'app' for the running container's stdout/stderr."),
                app: z.string().optional().describe("One service name to narrow to. Omit for every service."),
                limit: z.number().int().min(1).max(MAX_TARGET_LOG_LINES).optional(),
                filter: z.string().optional().describe("Case-insensitive substring pre-filter."),
                from: z.enum(["head", "tail"]).optional(),
            },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ applicationId, target, source, app, limit, filter, from }) =>
            analytics.track("get_target_logs", async () => {
                logger.info("get_target_logs", { applicationId, extra: { target, source } });
                try {
                    const organizationId = await resolveOrg(applicationId);
                    const resolved = await resolveDryRunTarget(services, applicationId, organizationId, target);
                    // External targets (a Vercel deployment, a BYO URL) run on hosting we
                    // do not operate, so there is no stream to read - say so rather than
                    // returning an empty tail the agent would read as "no errors".
                    if (resolved.repoFullName == null || resolved.prNumber == null) {
                        return unavailableResult(
                            `Target "${target}" is not an Autonoma-managed preview (${resolved.source}), so Autonoma ` +
                                "does not hold its logs. Read them wherever that deployment runs.",
                        );
                    }
                    const result = await services.previewkitLogs.tail({
                        repoFullName: resolved.repoFullName,
                        prNumber: resolved.prNumber,
                        source,
                        callerOrgId: organizationId,
                        app,
                        limit: limit ?? DEFAULT_TARGET_LOG_LINES,
                        filter,
                        from,
                    });
                    if (result == null) {
                        return unavailableResult(
                            `No ${source} logs found for target "${target}" - its preview may never have deployed, ` +
                                "or the logs have aged out (retained ~30 days).",
                        );
                    }
                    return jsonResult(result);
                } catch (err) {
                    logger.warn("get_target_logs failed", { applicationId, extra: { target, source }, err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "update_recipe",
        {
            title: "Update a scenario recipe",
            description:
                "Replace a scenario's recipe with a corrected version and make it the active one. The recipe's `name` " +
                "must stay the scenario's existing name - this EDITS an existing scenario, it does not create one (the " +
                "scenario and an initial recipe come from the planner upload). Every value in `create` must be " +
                "concrete except two built-in tokens, which need no declaration: `{{testRunId}}` (the id of this " +
                "provisioning run, the same value your SDK receives as the request's `testRunId`) and " +
                "`{{testRunShortId}}` (an 8-character hash of it, for columns too short for a UUID). Use them wherever " +
                "a value must be unique per run; any OTHER `{{token}}` is rejected. The recipe is validated on save - " +
                "an invalid shape, a `_ref` matching no `_alias`, or a token that cannot resolve is rejected with the " +
                "exact problem, so read it, fix it, and resend. After saving, call dry_run_scenario to run it " +
                "against the deployed app and confirm it actually creates the entities; loop update_recipe -> " +
                "dry_run_scenario until it passes. Pass a short `description` of what you changed - the user watches it " +
                "on the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                scenarioId: z.string(),
                recipe: ScenarioRecipeSchema,
                baseFingerprint: baseFingerprintInput,
                description: activityDescription,
            },
        },
        async ({ applicationId, scenarioId, recipe, baseFingerprint, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "update_recipe",
                    message: description ?? `Updating recipe for scenario "${recipe.name}"`,
                    toolArguments: { scenarioId, scenario: recipe.name },
                },
                (org) =>
                    services.scenarios.updateRecipe({
                        applicationId,
                        organizationId: org,
                        scenarioId,
                        fixtureJson: JSON.stringify(recipe),
                        source: "MCP",
                        actorUserId: userId,
                        baseFingerprint,
                    }),
            ),
    );

    server.registerTool(
        "validate_sdk",
        {
            title: "Validate the app's Autonoma SDK endpoint",
            description:
                "Check that the app's Autonoma SDK endpoint (the environment factory at `/api/autonoma`) is live on " +
                "a preview and answers correctly: it provisions the preview's Autonoma secrets, calls the handler's " +
                "`discover`, and on success stores the endpoint plus the model schema it returned. Run this BEFORE " +
                "dry_run_scenario - a dry run against an unvalidated endpoint just fails on the same thing twice. " +
                "Name the preview with a target `id` from list_dry_run_targets, normally the PR carrying the SDK " +
                "handler. Works on an Autonoma-hosted preview and on a Vercel deployment alike - it routes by where " +
                "the target's preview comes from. A preview from the project's own pipeline (neither of those) is " +
                "the one case it cannot do: validating that needs the signing secret their pipeline signs with, and " +
                "no tool here accepts a secret value, so it returns an error naming the UI step the user does " +
                "instead. A `redeploy_started` result is not a failure: the preview is being rebuilt to mount " +
                "freshly-provisioned secrets, so poll list_dry_run_targets until that target reads `ready` again " +
                "and call validate_sdk once more. A failure returns the handler's own error - read it, then " +
                "get_target_logs(target, source:'app') for the stack trace behind it, fix the handler in the repo, " +
                "push to the PR, and wait for its preview to redeploy before validating again. Only " +
                "Autonoma-hosted previews can be validated here; an app on its own hosting is " +
                "validated from the Autonoma UI, where the user supplies its signing secret. Pass a short " +
                "`description` - the user watches it on the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                target: z
                    .string()
                    .describe("A target `id` from list_dry_run_targets - the preview whose SDK endpoint to validate."),
                allowSelfHeal: z
                    .boolean()
                    .optional()
                    .describe(
                        "Leave unset on a first attempt. Set it to false on the retry AFTER a signature-rejection " +
                            "redeploy, so a rejection that survived that redeploy is reported instead of " +
                            "redeploying the preview a second time. Each response tells you which to send next.",
                    ),
                description: activityDescription,
            },
        },
        async ({ applicationId, target, allowSelfHeal = true, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "validate_sdk",
                    message: description ?? "Validating the SDK endpoint",
                    toolArguments: { target },
                },
                async (org) => {
                    // Dispatch on where the target's preview comes from, the same way the
                    // Autonoma UI does. The managed path below resolves the target through
                    // PreviewKit and rejects anything else outright, so without this a
                    // Vercel target - the only kind a Vercel app has - failed with "not
                    // managed by PreviewKit", which reads as a broken setup rather than
                    // the wrong code path.
                    const dispatch = await resolveSdkValidationRoute(applicationId, org, target);
                    // Thrown, not returned: guardedWrite wraps whatever the work returns
                    // in a success result, so handing it an error result nests one inside
                    // the other and the agent sees a JSON blob that is not flagged as a
                    // failure. Throwing lets the usual catch render it and marks the
                    // activity-feed entry as errored.
                    if (dispatch.route === "unsupported") throw new BadRequestError(dispatch.message);
                    if (dispatch.route === "vercel") {
                        const vercelResult = await services.onboarding.discoverVercelDeploymentTarget(
                            applicationId,
                            org,
                            target,
                            allowSelfHeal,
                        );
                        if (vercelResult.status === "redeploy_started") {
                            return {
                                status: "redeploy_started",
                                message:
                                    "The deployment rejected our signature because it was built before the shared " +
                                    "secret existed, so Vercel is building a fresh one. Poll " +
                                    `get_vercel_deployment_status with ${vercelResult.deploymentId} until it is ` +
                                    "ready, then call validate_sdk again with that id and allowSelfHeal: false. A " +
                                    "rejection that survives the rebuild is a real failure to report.",
                            };
                        }
                        return {
                            status: "discovered",
                            message:
                                "The SDK handler answered and its schema is stored. Next: the scenario recipes - " +
                                "list_scenarios, then dry_run_scenario against this same target.",
                        };
                    }
                    // Preparing writes the preview's AUTONOMA_* secrets; when that mounts
                    // something new it redeploys, and the pod has to roll before discover
                    // can succeed. Returning here (rather than discovering into a
                    // guaranteed 401) keeps the agent's next move a poll, not a retry.
                    const prepared = await services.onboarding.prepareSdkTarget(applicationId, org, target);
                    if (prepared.status === "redeploy_started") {
                        return {
                            status: "redeploy_started",
                            message:
                                "The preview is redeploying to mount its Autonoma secrets. Poll " +
                                "list_dry_run_targets until this target is `ready`, then call validate_sdk again.",
                        };
                    }
                    const result = await services.onboarding.configureAndDiscoverSdkTarget(
                        applicationId,
                        org,
                        target,
                        allowSelfHeal,
                    );
                    if (result.status === "redeploy_started") {
                        return {
                            status: "redeploy_started",
                            message:
                                "The endpoint rejected our signature, so the preview is redeploying onto the " +
                                "current shared secret. Poll list_dry_run_targets until this target is `ready`, " +
                                "then call validate_sdk again with allowSelfHeal: false. A rejection that " +
                                "survives this redeploy is a real failure to report, not something to redeploy " +
                                "through again.",
                        };
                    }
                    return {
                        status: "discovered",
                        message:
                            "The SDK endpoint answered and its schema is stored. Now run dry_run_scenario against " +
                            "this same target to confirm the scenarios provision.",
                    };
                },
            ),
    );

    server.registerTool(
        "dry_run_scenario",
        {
            title: "Test a scenario recipe",
            description:
                "Run a scenario's recipe end-to-end against the deployed app: calls your SDK endpoint `up` to create " +
                "the entities in the app's database, then `down` to tear them back down. This is how you confirm a " +
                "recipe works before onboarding completes. On failure it returns which phase failed (recipe/up/down) " +
                "and the SDK's error. " +
                "ITERATE HERE, do not save between attempts: pass your edited recipe as `recipe` and it is provisioned " +
                "WITHOUT being stored, so a wrong guess never becomes the recipe that future test runs use. Loop " +
                "dry_run_scenario(recipe) -> read the error -> edit -> dry_run_scenario(recipe) as many times as you " +
                "need, then pass `save: true` on the run that passes to make it the active recipe (it is saved only if " +
                "the whole up/down cycle succeeded, so a failing recipe can never be promoted). Omit `recipe` entirely " +
                "to run whatever is currently stored. Requires the app deployed with " +
                "its SDK URL + signing secret configured - get the preview up first. Cold starts are handled for you: a " +
                "scaled-to-zero ('serverless') preview 503s on the first hit while it wakes, so this tool waits through " +
                "that warm-up (a bounded retry, ~30s) before running - allow the first run extra time rather than " +
                "treating a slow response as a hang, and you normally never see the 503. Only if the preview is STILL " +
                "cold after that wait does it return `success:false` with `coldStart:true` and a plain-English note " +
                "(not a raw 503); then just call dry_run_scenario again, the environment is waking. Pass a short " +
                "`description` - the user watches it on the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                scenarioId: z.string(),
                recipe: ScenarioRecipeSchema.optional().describe(
                    "A candidate recipe to run INSTEAD of the stored one. Not persisted unless `save` is true.",
                ),
                save: z
                    .boolean()
                    .optional()
                    .describe(
                        "Make `recipe` the active recipe, but only if this run passes. Ignored without `recipe`.",
                    ),
                target: z
                    .string()
                    .optional()
                    .describe(
                        "A target `id` from list_dry_run_targets - the preview to provision against. Omit to use " +
                            "the app's currently configured SDK endpoint.",
                    ),
                description: activityDescription,
            },
        },
        async ({ applicationId, scenarioId, recipe, save = false, target, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "dry_run_scenario",
                    message: description ?? describeDryRun(recipe != null, save),
                    toolArguments: { scenarioId, candidate: recipe != null, save, target: target ?? null },
                },
                async (org) =>
                    services.scenarios.dryRun(
                        applicationId,
                        org,
                        scenarioId,
                        dryRunOptions(recipe, save, userId),
                        await resolveDryRunTargetUrl(services, applicationId, org, target),
                    ),
            ),
    );

    // ─── Prompt: a guided entry point the user can invoke ─────────────
    server.registerPrompt(
        "configure_preview",
        {
            title: "Configure my Autonoma preview",
            description:
                "Guided flow to configure, deploy, and verify this app's Autonoma preview during onboarding (and fix " +
                "its scenario recipes), using the pairing code from the Autonoma UI.",
            argsSchema: { code: z.string().optional() },
        },
        ({ code }) => {
            const pairingStep =
                code != null && code.length > 0
                    ? `Pair with code ${code}, then work`
                    : `Get the pairing code from the Autonoma UI ("Configure with coding agent") and call pair with it, then work`;
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text:
                                `Configure my Autonoma preview during onboarding. ${pairingStep} the loop below until ` +
                                `the preview is up and its scenario recipes pass.\n\n${ONBOARDING_INSTRUCTIONS}`,
                        },
                    },
                ],
            };
        },
    );

    server.registerPrompt(
        "connect_my_deploys",
        {
            title: "Connect my own deploys to Autonoma",
            description:
                "Guided flow for an app whose previews come from the user's own pipeline: wire that pipeline to " +
                "signal Autonoma when a preview is live, then prove the signal lands.",
            argsSchema: { code: z.string().optional() },
        },
        ({ code }) => {
            const pairingStep =
                code != null && code.length > 0
                    ? `Pair with code ${code}, then follow`
                    : `Get the pairing code from the Autonoma UI ("Configure with coding agent") and call pair with it, then follow`;
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text:
                                `Connect my existing deploys to Autonoma. ${pairingStep} the playbook below that ` +
                                `applies - pair() tells you which, and they are not interchangeable. On Vercel the ` +
                                `integration reports deployments already and the work is connecting the project; ` +
                                `anywhere else you wire a signed signal and must not call it done on an untested ` +
                                `workflow.` +
                                `\n\n${SHARED_PREAMBLE}\n\n${VERCEL_PLAYBOOK}\n\n${EXTERNAL_DEPLOYS_PLAYBOOK}\n\n${SDK_AND_RECIPES}`,
                        },
                    },
                ],
            };
        },
    );

    // ─── Resources: the guides, readable on demand ────────────────────
    server.registerResource(
        "onboarding-guide",
        "autonoma://onboarding-guide",
        {
            title: "Autonoma preview onboarding guide",
            description:
                "What Autonoma is and how to configure, deploy, and verify this app's preview - and fix its scenario " +
                "recipes - with these tools, in order.",
            mimeType: "text/markdown",
        },
        (uri) => ({
            contents: [{ uri: uri.href, text: ONBOARDING_INSTRUCTIONS, mimeType: "text/markdown" }],
        }),
    );

    // Every playbook is readable without pairing, so an agent can see what the
    // work looks like before it holds an app - and so one that pairs into a
    // less common path can re-read it without hunting through chat history.
    server.registerResource(
        "autonoma-hosted-playbook",
        "autonoma://autonoma-hosted-playbook",
        {
            title: "Autonoma-hosted previews playbook",
            description: "How to configure, deploy and verify a preview that Autonoma builds and hosts.",
            mimeType: "text/markdown",
        },
        (uri) => ({
            contents: [{ uri: uri.href, text: PREVIEWKIT_PLAYBOOK, mimeType: "text/markdown" }],
        }),
    );

    server.registerResource(
        "own-pipeline-playbook",
        "autonoma://own-pipeline-playbook",
        {
            title: "Your own pipeline playbook (signed webhook)",
            description:
                "How to wire a customer's own deploy pipeline to signal Autonoma when a preview is live, and how to " +
                "prove the signal lands. For every host EXCEPT Vercel - see the Vercel playbook for those.",
            mimeType: "text/markdown",
        },
        (uri) => ({
            contents: [{ uri: uri.href, text: EXTERNAL_DEPLOYS_PLAYBOOK, mimeType: "text/markdown" }],
        }),
    );

    server.registerResource(
        "vercel-playbook",
        "autonoma://vercel-playbook",
        {
            title: "Vercel previews playbook",
            description:
                "How to connect a Vercel project so its deployments become the previews Autonoma tests against - " +
                "the other half of the customer's-own-deploys path, where the Marketplace integration replaces the " +
                "signed webhook. Covers when this path is safe at all, and which deployment to point onboarding at.",
            mimeType: "text/markdown",
        },
        (uri) => ({
            contents: [{ uri: uri.href, text: VERCEL_PLAYBOOK, mimeType: "text/markdown" }],
        }),
    );

    registerSharedReadTools(server, {
        services,
        analytics,
        resolveTarget: (input) =>
            resolveMcpTarget(
                { db, listRepositories: (orgId) => services.github.listRepositories(orgId) },
                principal,
                input,
            ),
    });

    return server;
}
