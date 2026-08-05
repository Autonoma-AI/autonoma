import * as p from "../ui/prompts";
import type { AgentLauncher, KillableProcess, PermissionMode } from "./coding-agent";
import { debugLog } from "./debug";
import { captureLog } from "./logs";
import { isStepAtOrPast, PREVIEW_DONE_STEP } from "./onboarding-phase";

/** MCP server name the agent registers, and the name the prompt must say verbatim. */
export const MCP_SERVER_NAME = "autonoma";

/** How often the running agent's progress is checked against onboarding state. */
const PHASE_POLL_MS = 5000;

/** Phase complete -> let the agent finish its summary before the terminal is reclaimed. */
const PHASE_EXIT_GRACE_MS = 15_000;

/** SIGTERM ignored -> force-kill after this long. */
const KILL_ESCALATION_MS = 10_000;

/**
 * What the agent is started on. Names the server literally rather than "the Autonoma
 * MCP": an agent holding several servers cannot resolve a generic name - it picks one
 * and commits to it. Matches the sentence the web app hands out for the same job.
 */
function previewPrompt(code: string): string {
    return `set up my preview environments with the ${MCP_SERVER_NAME} MCP, code ${code}`;
}

/**
 * What this phase needs of the Autonoma client, and no more. `AutonomaClient`
 * satisfies it structurally, so nothing has to be threaded or cast at the call site -
 * and it states the dependency as "reads the step, mints a code" rather than "the
 * whole API".
 */
export interface OnboardingReader {
    getOnboardingState(applicationId: string): Promise<{ step: string }>;
    createAgentPairing(applicationId: string): Promise<string>;
}

export interface PreviewPhaseDeps {
    client: OnboardingReader;
    applicationId: string;
    launcher: AgentLauncher;
    permissionMode: PermissionMode;
    /** Bearer token for headless MCP auth. Omit interactively, where the agent signs in. */
    apiToken?: string;
    mcpUrl: string;
    interactive: boolean;
    /** Overridable so tests do not wait real seconds. */
    timing?: PhaseWatchTiming;
}

export interface PhaseWatchTiming {
    pollMs: number;
    graceMs: number;
    killMs: number;
}

const DEFAULT_TIMING: PhaseWatchTiming = {
    pollMs: PHASE_POLL_MS,
    graceMs: PHASE_EXIT_GRACE_MS,
    killMs: KILL_ESCALATION_MS,
};

/** How the preview phase ended, for the caller to decide what happens next. */
export type PreviewPhaseOutcome =
    | { kind: "verified" }
    /** The agent exited with the preview still unconfirmed - the run continues, but the
     *  dry run has nothing to hit until a preview exists. */
    | { kind: "incomplete"; step: string };

/**
 * Hand the preview environment to a fresh coding agent and wait for the platform to
 * say it is up.
 *
 * The CLI registers the MCP server first and only then spawns, which is the whole
 * reason this can work at all: a client loads its server list at startup, so a
 * session can never pick up a server it registered itself. A CLI process is not a
 * session.
 *
 * Completion is read from onboarding state, never from the agent. An interactive
 * agent session does not exit when its work is done - it sits open after its final
 * message - and its exit code says nothing about whether a preview deployed. Polling
 * the step is also what makes this path-agnostic: an Autonoma-hosted preview, a
 * Vercel deployment and a customer's own signed signal each advance the step in their
 * own way, and all this asks is whether it got there.
 */
export async function runPreviewPhase(deps: PreviewPhaseDeps): Promise<PreviewPhaseOutcome> {
    const timing = deps.timing ?? DEFAULT_TIMING;

    p.log.info(`Connecting ${deps.launcher.label} to Autonoma...`);
    const registration = await deps.launcher.registerMcpServer({
        name: MCP_SERVER_NAME,
        url: deps.mcpUrl,
        apiToken: deps.apiToken,
    });

    // Minted per handoff: codes are single-use and short-lived, and this run hands off
    // more than once.
    const code = await deps.client.createAgentPairing(deps.applicationId);
    captureLog("info", "Handing the preview environment to a coding agent", {
        source: "preview_phase",
        agent: deps.launcher.id,
    });

    p.log.info("Your agent is setting up your preview environment - watch it work, and steer it if you want to.");

    await deps.launcher.launch({
        message: previewPrompt(code),
        permissionMode: deps.permissionMode,
        interactive: deps.interactive,
        env: registration.env,
        // An interactive session never exits on its own, so onboarding state is what
        // says "done" and reclaims the terminal. Headless runs exit by themselves.
        watch: deps.interactive
            ? (proc) => watchForPreviewPhase(deps.client, deps.applicationId, proc, timing)
            : undefined,
    });

    const state = await deps.client.getOnboardingState(deps.applicationId);
    if (isStepAtOrPast(state.step, PREVIEW_DONE_STEP)) {
        p.log.success("Your preview environment is up.");
        captureLog("info", "Preview phase complete", { source: "preview_phase", step: state.step });
        return { kind: "verified" };
    }

    captureLog("warn", "Preview phase ended without a verified preview", {
        source: "preview_phase",
        step: state.step,
    });
    return { kind: "incomplete", step: state.step };
}

/**
 * Poll onboarding state while the agent runs; once the preview is verified, give the
 * agent a beat to finish its summary, then terminate it so control returns here.
 * Returns a cleanup fn, invoked when the process exits on its own.
 *
 * A failed poll is deliberately swallowed to a debug line: the network dropping for
 * one tick must not kill a working agent session, and the next tick answers anyway.
 */
export function watchForPreviewPhase(
    client: Pick<OnboardingReader, "getOnboardingState">,
    applicationId: string,
    proc: KillableProcess,
    timing: PhaseWatchTiming = DEFAULT_TIMING,
): () => void {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const poll = setInterval(() => {
        void client
            .getOnboardingState(applicationId)
            .then((state) => {
                if (!isStepAtOrPast(state.step, PREVIEW_DONE_STEP) || graceTimer != null) return;
                debugLog("Preview verified while the agent runs; scheduling terminal reclaim", { step: state.step });
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
