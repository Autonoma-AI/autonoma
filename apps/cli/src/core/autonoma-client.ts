import type { AppRouter } from "@autonoma/api/router";
import { createTRPCClient, httpLink, type TRPCClient } from "@trpc/client";
import superjson from "superjson";
import { debugLog } from "./debug";
import { captureLog } from "./logs";

/**
 * Where the API mounts tRPC. The CLI's other calls go to plain REST routers under
 * `/v1/...`; onboarding has no REST surface, so this is how it is reached.
 */
const TRPC_PATH = "/v1/trpc";

/** Ceiling on a status call, so a hung API can never stall a run indefinitely. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Ceiling on a call that reaches through the API into the customer's own deployed
 * app. Discovering a schema or provisioning a scenario boots a preview that may be
 * scaled to zero and then waits on the SDK handler, which the API itself allows 90
 * seconds per leg - and a dry run is two legs. The status timeout would abort those
 * mid-flight and report a failure the platform never saw.
 */
const SDK_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Onboarding state, exactly as the API returns it. */
export type OnboardingState = Awaited<ReturnType<TRPCClient<AppRouter>["onboarding"]["getState"]["query"]>>;

/** The preview environments a dry run can be pointed at, as the API returns them. */
export type SdkDryRunTargets = Awaited<
    ReturnType<TRPCClient<AppRouter>["onboarding"]["listSdkDryRunTargets"]["query"]>
>;

/** One such preview environment. Derived, so it cannot drift from the listing. */
export type SdkDryRunTarget = SdkDryRunTargets["targets"][number];

/**
 * The CLI's read/write access to onboarding, over the same tRPC surface - and the
 * same typed client - the web app uses. It authenticates with `AUTONOMA_API_TOKEN`:
 * the API accepts an API key on the `Authorization` header wherever it accepts a
 * session, so no separate CLI endpoint is needed for any of this.
 *
 * `@autonoma/api` is a type-only devDependency, exactly as it is in `apps/ui`. It
 * exports nothing at runtime (its `package.json` maps `./router` to `types` alone),
 * the import is erased at build, and the published package therefore does not depend
 * on it. What it buys is that renaming a procedure or changing its input breaks the
 * CLI's typecheck here, in this repo, rather than at runtime in someone's terminal.
 *
 * Kept to the calls the CLI actually makes. It reads state to decide where in
 * onboarding a run should start, mints pairing codes for the coding agents it spawns -
 * a fresh one per spawn, because codes are single-use and short-lived and one run hands
 * off more than once - and drives the SDK validation and scenario dry runs itself
 * rather than asking an agent to make those calls through the MCP.
 */
export class AutonomaClient {
    /** Status reads and other calls the API answers on its own. */
    private readonly trpc: TRPCClient<AppRouter>;
    /** Calls that reach through the API into the customer's deployed app. */
    private readonly slowTrpc: TRPCClient<AppRouter>;

    constructor(apiUrl: string, apiToken: string) {
        this.trpc = buildClient(apiUrl, apiToken, REQUEST_TIMEOUT_MS);
        this.slowTrpc = buildClient(apiUrl, apiToken, SDK_REQUEST_TIMEOUT_MS);
    }

    /** Onboarding state for the app, as the platform currently sees it. */
    async getOnboardingState(applicationId: string): Promise<OnboardingState> {
        debugLog("Reading onboarding state", { applicationId });
        const state = await this.trpc.onboarding.getState.query({ applicationId });
        captureLog("info", "Read onboarding state", {
            source: "onboarding",
            step: state.step,
            preview_mode: state.previewEnvironmentMode ?? "unset",
            sdk_configured: state.sdkConfigured,
            dry_run_passed: state.dryRunPassed,
        });
        return state;
    }

    /**
     * Re-check whether this app's preview environment is up.
     *
     * Called for its SIDE EFFECT as much as its answer: reading readiness is what
     * stamps a preview that has come up as `preview_verified`, and nothing else does.
     * `getOnboardingState` only reports the step someone else already stamped, so a
     * preview that goes ready after the agent stops polling would never be noticed by
     * a caller watching the step alone.
     */
    async refreshPreviewReadiness(applicationId: string): Promise<void> {
        debugLog("Refreshing preview readiness", { applicationId });
        await this.trpc.onboarding.getPreviewReadiness.query({ applicationId });
    }

    /**
     * Take the app live: from a verified preview through to Autonoma reviewing its
     * pull requests. Idempotent, and called without asking whether anyone already did.
     *
     * The CLI does this itself rather than leaving it to the coding agent, for the
     * same reason it makes the SDK and dry-run calls itself: no judgement is involved,
     * and asking an agent to make it is one more way for it not to happen. Here that
     * is not hypothetical - the preview phase stops the agent as soon as the platform
     * reports the preview verified, which is the exact moment the agent would have
     * gone live. Left to the agent, an app finishes a whole run one step short.
     */
    async takeAppLive(applicationId: string): Promise<{ alreadyLive: boolean; step: string }> {
        debugLog("Taking the app live", { applicationId });
        const result = await this.trpc.onboarding.takeLive.mutate({ applicationId });
        captureLog("info", "Took the app live", {
            source: "onboarding",
            step: result.step,
            already_live: result.alreadyLive,
        });
        return { alreadyLive: result.alreadyLive, step: result.step };
    }

    /**
     * Mint a single-use pairing code for a coding agent this CLI is about to spawn.
     * Codes expire, so mint one per handoff rather than reusing an earlier one.
     */
    async createAgentPairing(applicationId: string): Promise<string> {
        debugLog("Minting agent pairing code", { applicationId });
        const { code } = await this.trpc.onboarding.createAgentPairing.mutate({ applicationId });
        captureLog("info", "Minted agent pairing code", { source: "onboarding" });
        return code;
    }

    /**
     * The preview environments the SDK validation and the dry run can run against:
     * the app's main preview plus one per open pull request, each carrying whether it
     * is deployed yet and which one the platform recognizes as the SDK handler's PR.
     */
    async listDryRunTargets(applicationId: string): Promise<SdkDryRunTargets> {
        debugLog("Listing SDK dry-run targets", { applicationId });
        const targets = await this.trpc.onboarding.listSdkDryRunTargets.query({ applicationId });
        captureLog("info", "Listed SDK dry-run targets", {
            source: "dry_run",
            target_count: targets.targets.length,
            auto_detected: targets.autoDetectedTargetId != null,
        });
        return targets;
    }

    /**
     * Provision a managed preview's Autonoma secrets so it can be validated. Returns
     * `redeploy_started` when mounting them changed the running app, in which case the
     * preview has to come back up before anything else is worth trying.
     */
    async prepareSdkTarget(applicationId: string, targetId: string): Promise<{ status: "ready" | "redeploy_started" }> {
        debugLog("Preparing SDK target", { applicationId, targetId });
        return this.slowTrpc.onboarding.prepareSdkTarget.mutate({ applicationId, targetId });
    }

    /**
     * Call the app's SDK handler and store the schema it reports.
     *
     * `allowSelfHeal` lets the API redeploy once when the handler rejects our
     * signature, which for a managed preview can only be the platform's own secret
     * drift. Pass it on the first attempt and not on the retry, so a rejection that
     * survives a redeploy surfaces instead of looping.
     */
    async configureAndDiscoverSdkTarget(
        applicationId: string,
        targetId: string,
        allowSelfHeal: boolean,
    ): Promise<{ status: "discovered" | "redeploy_started" }> {
        debugLog("Discovering the SDK schema", { applicationId, targetId, allowSelfHeal });
        return this.slowTrpc.onboarding.configureAndDiscoverSdkTarget.mutate({
            applicationId,
            targetId,
            allowSelfHeal,
        });
    }

    /** The app's scenarios - the named states its tests depend on. */
    async listScenarios(applicationId: string): Promise<{ id: string; name: string }[]> {
        debugLog("Listing scenarios", { applicationId });
        return this.trpc.scenarios.list.query({ applicationId });
    }

    /**
     * Provision a scenario against a preview and tear it back down. The platform
     * records the app's dry run as passed once every scenario completes that cycle.
     */
    async runScenarioDryRun(
        applicationId: string,
        scenarioId: string,
        targetId: string,
    ): Promise<{ success: boolean; phase?: string; error?: unknown }> {
        debugLog("Running a scenario dry run", { applicationId, scenarioId, targetId });
        return this.slowTrpc.onboarding.runScenarioDryRun.mutate({ applicationId, scenarioId, targetId });
    }

    /**
     * Take the onboarding config mutex for this run, so the web app stops offering the
     * steps this run is about to do and points the user at their terminal instead.
     *
     * This is the same mutation behind the UI's "hand it back to the agent" control:
     * handing the mutex over is one state change whoever asks for it, and a second
     * procedure that set the same column would only be a way for the two to drift.
     *
     * Unconditional by design - a user starting this run IS the handoff, including
     * after an earlier take-over. What makes take-over stick is that this is called
     * once at the start of a run rather than polled, so a user who takes the config
     * back mid-run keeps it.
     */
    async claimAgentHold(applicationId: string): Promise<void> {
        debugLog("Claiming the onboarding config for this run", { applicationId });
        await this.trpc.onboarding.resumeAgent.mutate({ applicationId });
        captureLog("info", "Claimed the onboarding config for this run", { source: "onboarding" });
    }
}

/**
 * One tRPC client against the API's mount, with a per-call deadline. Split out so the
 * two the CLI holds differ in nothing but that deadline.
 */
function buildClient(apiUrl: string, apiToken: string, timeoutMs: number): TRPCClient<AppRouter> {
    return createTRPCClient<AppRouter>({
        links: [
            // httpLink, not httpBatchLink: the CLI makes a handful of calls minutes
            // apart, so batching has nothing to batch and only widens the blast
            // radius of one slow procedure.
            httpLink({
                url: `${apiUrl}${TRPC_PATH}`,
                transformer: superjson,
                headers: () => ({ Authorization: `Bearer ${apiToken}` }),
                // AbortSignal.timeout rather than a manual controller: the timer is
                // cleared with the signal, so a slow-but-successful call cannot leave
                // a pending timeout holding the event loop open at exit.
                fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }),
            }),
        ],
    });
}
