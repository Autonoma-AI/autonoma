import type { AppConfig } from "../config";
import * as p from "../ui/prompts";
import { resolveMcpUrl } from "./api-url";
import { AutonomaClient } from "./autonoma-client";
import {
    buildAllLaunchers,
    DEFAULT_PERMISSION_MODE,
    parsePermissionMode,
    selectLauncher,
    type AgentLauncher,
    type PermissionMode,
} from "./coding-agent";
import { debugLog } from "./debug";
import { resume, suspend } from "./interrupt";
import { captureLog } from "./logs";
import { resolveEntryPhase, type OnboardingPhase } from "./onboarding-phase";
import { runPreviewPhase, type PreviewPhaseOutcome } from "./preview-phase";

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
        return { client, applicationId, phase: resolveEntryPhase(state) };
    } catch (err) {
        p.log.warn("Couldn't read your setup status from Autonoma - continuing with the test-suite run.");
        debugLog("Front-door planning failed", { err });
        captureLog("warn", "Could not resolve the onboarding entry phase", { source: "front_door" });
        return undefined;
    }
}

export interface PreviewHandoffDeps {
    plan: FrontDoorPlan;
    config: AppConfig;
    nonInteractive: boolean;
    /** Test seam: inject launchers instead of probing PATH. */
    launchers?: AgentLauncher[];
}

/** How the preview handoff ended, for the caller to report and decide on. */
export type PreviewHandoffResult = PreviewPhaseOutcome | { kind: "no-agent" };

/**
 * Run the preview phase: register the MCP server with the user's coding agent, hand
 * it the job, and wait for the platform to confirm the preview is up.
 *
 * The terminal is handed over the way the SDK step already does it - the dashboard
 * steps aside while the agent has the screen, and comes back when it exits.
 *
 * Authorization splits on whether there is a human: interactively the agent signs in
 * through its own browser flow, which is the better credential (scoped, revocable by
 * signing out). Headless there is no browser, so the run's API token goes in as a
 * bearer header instead.
 */
export async function runPreviewHandoff(deps: PreviewHandoffDeps): Promise<PreviewHandoffResult> {
    const { plan, config, nonInteractive } = deps;
    const interactive = !nonInteractive;

    const launchers = deps.launchers ?? buildAllLaunchers({ cwd: config.projectRoot, env: process.env });
    const launcher = await selectLauncher(launchers, config.agent, interactive);
    if (launcher == null) {
        captureLog("warn", "No coding agent available for the preview phase", { source: "front_door" });
        return { kind: "no-agent" };
    }

    const permissionMode: PermissionMode = parsePermissionMode(config.permissionMode) ?? DEFAULT_PERMISSION_MODE;

    suspend();
    try {
        return await runPreviewPhase({
            client: plan.client,
            applicationId: plan.applicationId,
            launcher,
            permissionMode,
            apiToken: interactive ? undefined : config.autonomaApiToken,
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
