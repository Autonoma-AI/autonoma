import { INTEGRATION_BRANCH } from "@autonoma/types";
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
 * How every agent handoff paces itself, shared by all of them.
 *
 * One set of knobs rather than one per phase: they describe how long to let an agent
 * settle and how hard to insist it stops, which is a property of handing work to an
 * agent at all, not of which work it was handed. A per-phase copy reads as a decision
 * somebody made and is really just a duplicate that rots the first time one is tuned.
 */
export const DEFAULT_PHASE_TIMING: PhaseWatchTiming = {
    pollMs: PHASE_POLL_MS,
    graceMs: PHASE_EXIT_GRACE_MS,
    killMs: KILL_ESCALATION_MS,
};

/**
 * Appended only when there is no human on the other end.
 *
 * A headless agent runs in print mode, where asking a question IS ending the turn -
 * there is no "wait for the human" state to return from. So the two things that end
 * a run early both have to be pre-empted: stopping to ask, and treating "I tried" as
 * "I am done". Both were observed: an agent stopped to ask which secrets to set, and
 * reported the preview verified while the deploy had in fact failed.
 */
const HEADLESS_GUIDANCE =
    " You are running with no human to answer you, so where you would ask a question, choose the " +
    "safer option and say which you chose. You are not finished when you have tried - you are " +
    "finished when the preview is verified. If a deploy fails, read its logs, fix the cause and " +
    "deploy again. Never report success you have not confirmed.";

/**
 * Which name to call the app by, said here because the agent picks one before it has read
 * anything: the MCP's instructions open by teaching an agent in a checkout to read "owner/repo"
 * off the git remote, which is the wrong half of them for an app that is being onboarded. There
 * may be no repository linked yet, and there is no pull request at all - so an agent that reaches
 * for the repo name loses the deploy-debug tools exactly when the deploy it is debugging fails.
 */
const IDENTITY_GUIDANCE =
    " Call every Autonoma tool with the applicationId that `pair` returns - including the " +
    "deploy-debug ones (get_deploy_status, diagnose_deploy, get_build_logs, get_app_logs) - " +
    "rather than looking up this repository's name. Where a tool asks for prNumber, pass 0: that " +
    "is the base environment, the one onboarding sets up, and this app has no pull request yet.";

/**
 * Said here as well as in the MCP's own playbook, because it has to happen BEFORE the
 * first edit and the agent may make one while still reading the playbook. Getting a
 * preview to build takes commits, and they do not belong on the developer's default
 * branch until a preview has actually built from them.
 */
const BRANCH_GUIDANCE =
    ` Before you change any file: if you are not already on the \`${INTEGRATION_BRANCH}\` branch, create it ` +
    "off the repo's default branch and switch to it now - read the default branch from the remote " +
    "(`git symbolic-ref refs/remotes/origin/HEAD`) rather than assuming it is called main, and never commit " +
    "onto it. If the working tree already has uncommitted changes they are the developer's: branch off the " +
    "current HEAD instead and keep them out of your commits. Push the branch before you name it to Autonoma.";

/**
 * What the agent is started on.
 *
 * The instruction itself is WORD FOR WORD the sentence the web app hands out for this
 * job, and must stay that way: it is the one wording validated by people running it by
 * hand, and the interactive path here is the same act with the registration and the
 * pairing code done for them. Names the server literally rather than "the Autonoma
 * MCP" for the same reason the web app does - an agent holding several servers cannot
 * resolve a generic name, it picks one and commits to it. Everything after that
 * sentence is guidance appended around it, never edits to it.
 */
function previewPrompt(code: string, interactive: boolean): string {
    const instruction = `set up my preview environments with the ${MCP_SERVER_NAME} MCP, code ${code}`;
    const guided = `${instruction}.${IDENTITY_GUIDANCE}${BRANCH_GUIDANCE}`;
    return interactive ? guided : `${guided}${HEADLESS_GUIDANCE}`;
}

/**
 * What this phase needs of the Autonoma client, and no more. `AutonomaClient`
 * satisfies it structurally, so nothing has to be threaded or cast at the call site -
 * and it states the dependency as "reads the step, mints a code" rather than "the
 * whole API".
 */
export interface OnboardingReader {
    getOnboardingState(applicationId: string): Promise<{ step: string }>;
    /** Re-checks readiness, which is what stamps a preview that has come up. */
    refreshPreviewReadiness(applicationId: string): Promise<void>;
    createAgentPairing(applicationId: string): Promise<string>;
}

export interface PreviewPhaseDeps {
    client: OnboardingReader;
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

export interface PhaseWatchTiming {
    pollMs: number;
    graceMs: number;
    killMs: number;
}

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
    const timing = deps.timing ?? DEFAULT_PHASE_TIMING;

    p.log.info(`Connecting ${deps.launcher.label} to Autonoma...`);
    const registration = await deps.launcher.registerMcpServer({
        name: MCP_SERVER_NAME,
        url: deps.mcpUrl,
        apiToken: deps.apiToken,
        browserSignIn: deps.interactive,
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
        message: previewPrompt(code, deps.interactive),
        permissionMode: deps.permissionMode,
        interactive: deps.interactive,
        env: registration.env,
        // Both modes, not just interactive. An interactive session plainly never exits
        // on its own - it sits open after its final message - but a headless one is no
        // safer to wait on: observed in practice finishing the actual work and then
        // continuing to potter, with the run blocked behind it. Onboarding state is
        // what says "done", so it ends the handoff either way.
        watch: (proc) => watchForPreviewPhase(deps.client, deps.applicationId, proc, timing),
    });

    const state = await readVerifiedState(deps.client, deps.applicationId);
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
    client: Pick<OnboardingReader, "getOnboardingState" | "refreshPreviewReadiness">,
    applicationId: string,
    proc: KillableProcess,
    timing: PhaseWatchTiming = DEFAULT_PHASE_TIMING,
): () => void {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const poll = setInterval(() => {
        void readVerifiedState(client, applicationId)
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

/**
 * The step, having first given the platform a chance to notice a preview that came
 * up. Reading readiness is what stamps `preview_verified`; the step on its own only
 * reports what someone else already stamped, so a preview that goes ready after the
 * agent stops polling would never be seen. A failed refresh is not fatal - the step
 * is still worth reading, and the next poll asks again.
 */
async function readVerifiedState(
    client: Pick<OnboardingReader, "getOnboardingState" | "refreshPreviewReadiness">,
    applicationId: string,
): Promise<{ step: string }> {
    await client.refreshPreviewReadiness(applicationId).catch((err: unknown) => {
        debugLog("Could not refresh preview readiness", { err });
    });
    return client.getOnboardingState(applicationId);
}
