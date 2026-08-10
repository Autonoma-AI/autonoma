import type { AppConfig } from "../config";
import * as p from "../ui/prompts";
import { resolveMcpUrl } from "./api-url";
import { AutonomaClient } from "./autonoma-client";
import { buildAllLaunchers, parsePermissionMode, selectLauncher, type AgentLauncher } from "./coding-agent";
import { debugLog } from "./debug";
import { resume, suspend } from "./interrupt";
import { captureLog } from "./logs";
import { resolveEntryPhase, type OnboardingPhase } from "./onboarding-phase";
import { resolvePermissionMode } from "./permission-mode";
import { runPreviewPhase, type PreviewPhaseOutcome } from "./preview-phase";
import { runSdkRepairPhase, type SdkReadiness, type SdkRepairOutcome } from "./sdk-repair-phase";

/** What a run has left to do, and what it needs to do it. */
export interface FrontDoorPlan {
    client: AutonomaClient;
    applicationId: string;
    phase: OnboardingPhase;
}

/**
 * Work out where this run should start.
 *
 * Returns undefined when the run is not linked to an Autonoma application - the
 * planner still runs standalone against any repo, and that path must not acquire a
 * dependency on onboarding. It also returns undefined when onboarding cannot be read
 * at all: a planner run that would otherwise work is not worth failing over a
 * status call, so the run degrades to the pipeline it has always done.
 */
export async function planFrontDoor(config: AppConfig): Promise<FrontDoorPlan | undefined> {
    const { autonomaApplicationId: applicationId, autonomaApiToken: apiToken } = config;
    if (applicationId == null || apiToken == null) {
        debugLog("No application id or token; running the pipeline standalone");
        return undefined;
    }

    const client = new AutonomaClient(config.autonomaApiUrl, apiToken);
    try {
        const state = await client.getOnboardingState(applicationId);
        const phase = resolveEntryPhase(state);
        await claimHoldForRun(client, applicationId, phase);
        return { client, applicationId, phase };
    } catch (err) {
        p.log.warn("Couldn't read your setup status from Autonoma - continuing with the test-suite run.");
        debugLog("Front-door planning failed", { err });
        captureLog("warn", "Could not resolve the onboarding entry phase", { source: "front_door" });
        return undefined;
    }
}

/**
 * Take the config mutex for this run, so the web app renders "continue in your
 * terminal" instead of the steps this run is already doing.
 *
 * Only from the planner phase on. Before that the run hands the preview setup to a
 * coding agent, and pairing takes the mutex with a real connected agent behind it -
 * claiming ahead of that would put the agent activity screen on screen with nothing
 * yet to feed it.
 *
 * Best effort: this decides what a web page renders, and no run should end over it.
 */
async function claimHoldForRun(client: AutonomaClient, applicationId: string, phase: OnboardingPhase): Promise<void> {
    if (phase === "preview" || phase === "done") return;
    try {
        await client.claimAgentHold(applicationId);
    } catch (err) {
        debugLog("Could not claim the onboarding config for this run", { err });
        captureLog("warn", "Could not claim the onboarding config for this run", { source: "front_door" });
    }
}

/**
 * What the preview handoff needs of the Autonoma client, and no more: the calls the
 * preview phase makes, plus taking the app live once it confirms. `AutonomaClient`
 * satisfies it structurally, so nothing is threaded or cast at the real call site -
 * and the handoff can be exercised without standing up the whole client.
 */
export interface PreviewHandoffClient {
    /**
     * Declared rather than inherited from the two phase readers: they each ask for the
     * part of the state they use, and one call cannot return two different shapes. The
     * union is what the real client returns, and it satisfies both.
     */
    getOnboardingState(applicationId: string): Promise<{ step: string } & SdkReadiness>;
    refreshPreviewReadiness(applicationId: string): Promise<void>;
    createAgentPairing(applicationId: string): Promise<string>;
    takeAppLive(applicationId: string): Promise<{ alreadyLive: boolean; step: string }>;
}

export interface PreviewHandoffDeps {
    plan: { client: PreviewHandoffClient; applicationId: string };
    config: AppConfig;
    nonInteractive: boolean;
    /** Test seam: inject launchers instead of probing PATH. */
    launchers?: AgentLauncher[];
}

/** How the preview handoff ended, for the caller to report and decide on. */
export type PreviewHandoffResult =
    | PreviewPhaseOutcome
    /** No coding agent is installed, so there was nothing to hand the preview to. */
    | { kind: "no-agent" };

/**
 * Run the preview phase: register the MCP server with the user's coding agent, hand
 * it the job, and wait for the platform to confirm the preview is up.
 *
 * The terminal is handed over the way the SDK step already does it - the dashboard
 * steps aside while the agent has the screen, and comes back when it exits.
 *
 * Authorization prefers a human where there is one: interactively the agent signs in
 * through its own browser flow, which is the better credential (scoped, revocable by
 * signing out). The run's API token goes along either way - headless it is the only
 * way to authorize, and interactively it is what the sign-in falls back to rather
 * than losing the run to a browser that would not open.
 */
export async function runPreviewHandoff(deps: PreviewHandoffDeps): Promise<PreviewHandoffResult> {
    const { plan, config, nonInteractive } = deps;
    const interactive = !nonInteractive;

    const launchers = deps.launchers ?? buildAllLaunchers({ cwd: config.projectRoot, env: process.env });
    const launcher = await selectLauncher(launchers, config.agent, interactive);
    if (launcher == null) {
        // The only way to get here is with nothing installed: several installed and
        // nobody to ask resolves to the first rather than to no agent at all.
        captureLog("warn", "No coding agent available for the preview phase", { source: "front_door" });
        return { kind: "no-agent" };
    }

    // Asked, not assumed - but asked once for the whole run. The later handoffs
    // resolve through the same call and reuse whatever this one settled on.
    const permissionMode = await resolvePermissionMode({
        preset: parsePermissionMode(config.permissionMode),
        interactive,
    });

    suspend();
    let outcome: PreviewPhaseOutcome;
    try {
        outcome = await runPreviewPhase({
            client: plan.client,
            applicationId: plan.applicationId,
            launcher,
            permissionMode,
            apiToken: config.autonomaApiToken,
            mcpUrl: resolveMcpUrl(config.autonomaApiUrl),
            interactive,
        });
    } finally {
        resume();
    }

    if (outcome.kind === "verified") await takeAppLive(plan);
    return outcome;
}

/**
 * Turn pull-request reviews on, now that the preview is confirmed.
 *
 * The agent is told to do this itself, and on the web path it does. It cannot here:
 * the preview phase stops the agent the moment the platform reports the preview
 * verified, which is the exact moment the agent would have gone live. Left to it, a
 * run finishes every step and the app is still not being reviewed - which is what a
 * front-door run did until this call existed.
 *
 * Never fatal. The suite is generated and the SDK wired up regardless, and an app
 * left one step short is finished from the web in one click - losing the whole run
 * over it would be the worse failure.
 */
async function takeAppLive(plan: { client: PreviewHandoffClient; applicationId: string }): Promise<void> {
    try {
        const { alreadyLive } = await plan.client.takeAppLive(plan.applicationId);
        p.log.success(
            alreadyLive ? "Autonoma is reviewing your pull requests." : "Autonoma is now reviewing your pull requests.",
        );
    } catch (err) {
        debugLog("Could not take the app live", { err });
        captureLog("warn", "Could not take the app live", { source: "front_door" });
        p.log.warn(
            "Your preview is up, but Autonoma is not reviewing your pull requests yet - take the app live in the " +
                "Autonoma app to finish.",
        );
    }
}

/**
 * Hand the outstanding SDK and dry-run work to a fresh coding agent.
 *
 * Same handover the preview phase performs, for the same reason: a CLI process is not
 * an agent session, so it can register the MCP server and then spawn an agent that
 * picks it up. Returns undefined when there is no agent to hand to, which leaves the
 * run reporting what it found instead.
 */
export async function runSdkRepairHandoff(deps: PreviewHandoffDeps): Promise<SdkRepairOutcome | undefined> {
    const { plan, config, nonInteractive } = deps;
    const interactive = !nonInteractive;

    const launchers = deps.launchers ?? buildAllLaunchers({ cwd: config.projectRoot, env: process.env });
    const launcher = await selectLauncher(launchers, config.agent, interactive);
    if (launcher == null) {
        captureLog("warn", "No coding agent available for the SDK repair phase", { source: "front_door" });
        return undefined;
    }

    const permissionMode = await resolvePermissionMode({
        preset: parsePermissionMode(config.permissionMode),
        interactive,
    });

    suspend();
    try {
        return await runSdkRepairPhase({
            client: plan.client,
            applicationId: plan.applicationId,
            launcher,
            permissionMode,
            apiToken: config.autonomaApiToken,
            mcpUrl: resolveMcpUrl(config.autonomaApiUrl),
            interactive,
        });
    } finally {
        resume();
    }
}

/** What to tell the user when the preview phase did not finish the job. */
export function describeIncompletePreview(result: PreviewHandoffResult): string | undefined {
    if (result.kind === "verified") return undefined;
    if (result.kind === "no-agent") {
        return (
            "No supported coding agent was found on your PATH, so the preview environment was skipped. " +
            "Install Claude Code or the Codex CLI and run again, or set the preview up in the Autonoma app."
        );
    }
    return (
        "Your preview environment isn't confirmed yet, so scenario dry runs will have nothing to run against. " +
        "Finish it in the Autonoma app (or run again) - the rest of the run continues either way."
    );
}
