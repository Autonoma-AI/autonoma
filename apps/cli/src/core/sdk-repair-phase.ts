import * as p from "../ui/prompts";
import type { AgentLauncher, KillableProcess, PermissionMode } from "./coding-agent";
import { debugLog } from "./debug";
import { captureLog } from "./logs";
import { DEFAULT_PHASE_TIMING, MCP_SERVER_NAME, type PhaseWatchTiming } from "./preview-phase";

/**
 * Appended only when there is no human on the other end. Same reasoning as the
 * preview phase: in print mode, asking a question IS ending the turn, and "I tried"
 * must not be mistaken for "I am done".
 */
const HEADLESS_GUIDANCE =
    " You are running with no human to answer you, so where you would ask a question, choose the " +
    "safer option and say which you chose. You are not finished when you have tried - you are " +
    "finished when Autonoma reports the scenario dry run passed. Never report success you have not confirmed.";

/**
 * What the agent is started on.
 *
 * Names the outcome rather than the steps. Which of the several things is wrong -
 * the pull request has no preview, the handler 404s, a recipe resolves to nothing -
 * is exactly what the agent has to work out, and the MCP carries the tools for each:
 * `list_dry_run_targets` to see the state of every preview, `get_target_logs` for the
 * handler's own stack traces, `validate_sdk` and `dry_run_scenario` to try again
 * without a redeploy. Listing them here would only pick one story in advance.
 */
function repairPrompt(code: string, interactive: boolean): string {
    const instruction =
        `use the ${MCP_SERVER_NAME} MCP, code ${code}, to get my Autonoma SDK answering and my scenario ` +
        `dry run passing - fix whatever is in the way, in this repo or in the config, and keep going until ` +
        `Autonoma reports both`;
    return interactive ? instruction : `${instruction}.${HEADLESS_GUIDANCE}`;
}

/** The two facts this phase exists to make true, as the platform reports them. */
export interface SdkReadiness {
    sdkConfigured: boolean;
    dryRunPassed: boolean;
}

/**
 * What this phase needs of the Autonoma client, and no more. `AutonomaClient`
 * satisfies it structurally.
 */
export interface SdkRepairReader {
    getOnboardingState(applicationId: string): Promise<SdkReadiness>;
    createAgentPairing(applicationId: string): Promise<string>;
}

export interface SdkRepairPhaseDeps {
    client: SdkRepairReader;
    applicationId: string;
    launcher: AgentLauncher;
    permissionMode: PermissionMode;
    /**
     * The run's own credential. Always pass it when the run holds one: headless it is
     * the only way to authorize the MCP server, and interactively it is what a failed
     * browser sign-in falls back to.
     */
    apiToken?: string;
    mcpUrl: string;
    interactive: boolean;
    /** Overridable so tests do not wait real seconds. */
    timing?: PhaseWatchTiming;
}

/** How the repair ended, read from the platform rather than from the agent. */
export type SdkRepairOutcome =
    | { kind: "passed" }
    /** The agent stopped with one or both still outstanding. */
    | { kind: "incomplete"; sdkConfigured: boolean; dryRunPassed: boolean };

/** Both true - the only state in which this phase has nothing left to do. */
function isDone(state: SdkReadiness): boolean {
    return state.sdkConfigured && state.dryRunPassed;
}

/**
 * Hand the SDK and the scenario dry run to a fresh coding agent, and wait for the
 * platform to report both good.
 *
 * The CLI tries these itself first, because on a healthy app they are two API calls
 * that need no judgement. This runs when that did not work - and everything that
 * makes it not work needs exactly what the CLI does not have: a look at the repo, and
 * a decision. A pull request with no preview environment, a handler that 404s, a
 * recipe that resolves to nothing. Reporting those and exiting leaves the user a
 * finished run and an app that cannot run a test, which is most of a setup and none
 * of the point.
 *
 * Completion is read from onboarding state, never from the agent, for the same reason
 * the preview phase reads it: an interactive session does not exit when its work is
 * done, and an agent's own account of whether an endpoint answers is not evidence.
 */
export async function runSdkRepairPhase(deps: SdkRepairPhaseDeps): Promise<SdkRepairOutcome> {
    const timing = deps.timing ?? DEFAULT_PHASE_TIMING;

    const before = await deps.client.getOnboardingState(deps.applicationId);
    if (isDone(before)) return { kind: "passed" };

    p.log.info(`Connecting ${deps.launcher.label} to Autonoma...`);
    const registration = await deps.launcher.registerMcpServer({
        name: MCP_SERVER_NAME,
        url: deps.mcpUrl,
        apiToken: deps.apiToken,
        browserSignIn: deps.interactive,
    });

    // Minted per handoff: codes are single-use and short-lived, and this is the
    // second or third time this run has handed off.
    const code = await deps.client.createAgentPairing(deps.applicationId);
    captureLog("info", "Handing the SDK and dry run to a coding agent", {
        source: "sdk_repair_phase",
        agent: deps.launcher.id,
        sdk_configured: before.sdkConfigured,
        dry_run_passed: before.dryRunPassed,
    });

    p.log.info("Your agent is getting your test data working - watch it, and steer it if you want to.");

    await deps.launcher.launch({
        message: repairPrompt(code, deps.interactive),
        permissionMode: deps.permissionMode,
        interactive: deps.interactive,
        env: registration.env,
        watch: (proc) => watchForSdkRepair(deps.client, deps.applicationId, proc, timing),
    });

    const after = await deps.client.getOnboardingState(deps.applicationId);
    if (isDone(after)) {
        p.log.success("Your test data provisions against your preview.");
        captureLog("info", "SDK repair phase complete", { source: "sdk_repair_phase" });
        return { kind: "passed" };
    }

    captureLog("warn", "SDK repair phase ended with work outstanding", {
        source: "sdk_repair_phase",
        sdk_configured: after.sdkConfigured,
        dry_run_passed: after.dryRunPassed,
    });
    return { kind: "incomplete", sdkConfigured: after.sdkConfigured, dryRunPassed: after.dryRunPassed };
}

/**
 * Poll onboarding state while the agent runs; once both facts are true, give the
 * agent a beat to finish its summary, then terminate it so control returns here.
 * Returns a cleanup fn, invoked when the process exits on its own.
 *
 * A failed poll is swallowed to a debug line: one dropped tick must not kill a
 * working session, and the next tick answers anyway.
 */
export function watchForSdkRepair(
    client: Pick<SdkRepairReader, "getOnboardingState">,
    applicationId: string,
    proc: KillableProcess,
    timing: PhaseWatchTiming = DEFAULT_PHASE_TIMING,
): () => void {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const poll = setInterval(() => {
        void client
            .getOnboardingState(applicationId)
            .then((state) => {
                if (!isDone(state) || graceTimer != null) return;
                debugLog("SDK and dry run both good while the agent runs; scheduling terminal reclaim");
                clearInterval(poll);
                graceTimer = setTimeout(() => {
                    proc.kill("SIGTERM");
                    killTimer = setTimeout(() => proc.kill("SIGKILL"), timing.killMs);
                }, timing.graceMs);
            })
            .catch((err: unknown) => {
                debugLog("Could not read onboarding state while the agent runs", { err });
            });
    }, timing.pollMs);

    return () => {
        clearInterval(poll);
        if (graceTimer != null) clearTimeout(graceTimer);
        if (killTimer != null) clearTimeout(killTimer);
    };
}
