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

/** Ceiling on any single call, so a hung API can never stall a run indefinitely. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Onboarding state, exactly as the API returns it. */
export type OnboardingState = Awaited<ReturnType<TRPCClient<AppRouter>["onboarding"]["getState"]["query"]>>;

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
 * onboarding a run should start, and mints pairing codes for the coding agents it
 * spawns - a fresh one per spawn, because codes are single-use and short-lived and one
 * run hands off more than once.
 */
export class AutonomaClient {
    private readonly trpc: TRPCClient<AppRouter>;

    constructor(apiUrl: string, apiToken: string) {
        this.trpc = createTRPCClient<AppRouter>({
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
                    fetch: (url, options) =>
                        fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
                }),
            ],
        });
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
     * Mint a single-use pairing code for a coding agent this CLI is about to spawn.
     * Codes expire, so mint one per handoff rather than reusing an earlier one.
     */
    async createAgentPairing(applicationId: string): Promise<string> {
        debugLog("Minting agent pairing code", { applicationId });
        const { code } = await this.trpc.onboarding.createAgentPairing.mutate({ applicationId });
        captureLog("info", "Minted agent pairing code", { source: "onboarding" });
        return code;
    }
}
