import { debugLog } from "./debug";
import { runDryRunPhase, type DryRunPhaseOutcome, type DryRunReader, type DryRunTiming } from "./dry-run-phase";
import { captureLog } from "./logs";
import { isStepAtOrPast, LIVE_STEP } from "./onboarding-phase";

/**
 * What the platform makes of this app once the run is over. Every field is derived
 * from real evidence - artifacts that landed, an endpoint that answered, scenarios
 * that provisioned - never from anything this CLI or an agent claimed.
 */
export interface FinishState {
    step: string;
    artifactsUploaded: boolean;
    sdkConfigured: boolean;
    dryRunPassed: boolean;
}

/** What this phase needs of the Autonoma client. `AutonomaClient` satisfies it. */
export type FinishReader = DryRunReader & {
    getOnboardingState(applicationId: string): Promise<FinishState>;
};

export interface FinishPhaseDeps {
    client: FinishReader;
    applicationId: string;
    /** The branch the project is checked out on - which preview carries the handler. */
    checkedOutBranch?: string;
    /** Overridable so tests do not wait real minutes. */
    timing?: DryRunTiming;
}

export interface FinishPhaseResult {
    dryRun: DryRunPhaseOutcome;
    /** Where the app stood once the dry run was done with it. */
    state: FinishState;
    /** Autonoma is reviewing this app's pull requests. */
    live: boolean;
}

/**
 * The last stretch of a front-door run: prove the app's scenarios provision against a
 * real preview, then read back what the platform makes of the whole thing.
 *
 * Going live is not a decision made here. The coding agent takes the app live as soon
 * as its preview is verified, long before this runs - so this reads whether that
 * happened rather than doing it, and says so either way. A run that reports "you are
 * live" off its own actions rather than the platform's state is exactly the mistake
 * the preview phase already learned not to make.
 */
export async function runFinishPhase(deps: FinishPhaseDeps): Promise<FinishPhaseResult> {
    const dryRun = await runDryRunPhase({
        client: deps.client,
        applicationId: deps.applicationId,
        checkedOutBranch: deps.checkedOutBranch,
        timing: deps.timing,
    });

    const state = await deps.client.getOnboardingState(deps.applicationId);
    const live = isStepAtOrPast(state.step, LIVE_STEP);

    debugLog("Finish phase complete", { dryRun: dryRun.kind, step: state.step, live });
    captureLog("info", "Front-door run finished", {
        source: "finish_phase",
        dry_run: dryRun.kind,
        step: state.step,
        live,
        artifacts_uploaded: state.artifactsUploaded,
        sdk_configured: state.sdkConfigured,
        dry_run_passed: state.dryRunPassed,
    });

    return { dryRun, state, live };
}

/**
 * The closing summary, one line per thing the platform can now do - or cannot yet,
 * and why. Read from onboarding state rather than from what this run did, so a step
 * someone completed by hand between runs reads as done.
 */
export function describeFinishPhase(result: FinishPhaseResult): string[] {
    const { state } = result;
    return [
        `Test suite: ${state.artifactsUploaded ? "uploaded to Autonoma" : "not uploaded yet"}`,
        `Autonoma SDK: ${state.sdkConfigured ? "connected to your app" : "not answering yet"}`,
        `Scenario data: ${describeDryRunState(result)}`,
        result.live
            ? "Autonoma is reviewing your pull requests."
            : "Autonoma is not reviewing your pull requests yet - take your app live in the Autonoma app to finish.",
    ];
}

function describeDryRunState(result: FinishPhaseResult): string {
    if (result.state.dryRunPassed) return "provisions against your preview";
    if (result.dryRun.kind === "no-scenarios") return "no scenarios to provision";
    return "not confirmed yet";
}
