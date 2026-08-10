import type { OnboardingPreviewEnvironmentMode, OnboardingStep } from "@autonoma/db";
import type { PreviewDiagnosticsStatus } from "./preview-readiness";

/**
 * What `go_live` tells an agent, in each of the situations it can be
 * called from.
 *
 * The onboarding state machine rejects an out-of-order transition with `Cannot
 * <action> during "<step>" step`, which names the failure but not the fix - and
 * an agent handed that will usually retry the same call. These turn the step the
 * app is actually on into the one call that moves it forward, so a premature
 * attempt reads as a redirect rather than a dead end.
 */

/** The refusal for an app that has not reached a verified preview yet. */
export function describeUnfinishedStep(step: OnboardingStep, previewStatus: PreviewDiagnosticsStatus): string {
    return (
        `Nothing to finish: this app is on the "${step}" step, which is before its preview is verified, and going ` +
        `live commits Autonoma to reviewing pull requests against a preview that does not exist yet. ` +
        `${nextStepFor(step, previewStatus)} Then call go_live again.`
    );
}

/**
 * Steps kept in the enum for rows written by an onboarding flow we no longer
 * run. They have no state class in `OnboardingManager.states`, so no tool here
 * advances one, and the only way forward is the UI.
 */
function legacyStep(): string {
    return (
        "This app sits on an onboarding step that predates the current flow, so none of these tools moves " +
        "it. Call pair again and follow the playbook it returns; if the step does not change, the user has " +
        "to continue in the Autonoma UI."
    );
}

/**
 * The one call that moves an app forward, for every step it can be sitting on.
 *
 * Keyed by every member of `OnboardingStep` rather than switched with a
 * fallback: the compiler then refuses a new step until someone writes its
 * guidance, where a `default` branch would quietly answer "this step predates
 * the current flow" - the one message guaranteed to be wrong for a step that
 * was just added. It costs an explicit entry per legacy step, which also makes
 * the legacy set visible instead of implied.
 */
const NEXT_STEP: Record<OnboardingStep, (previewStatus: PreviewDiagnosticsStatus) => string> = {
    install: legacyStep,
    configure: legacyStep,
    working: legacyStep,
    webhook_configuring: legacyStep,
    discovering: legacyStep,
    discovered: legacyStep,
    dry_run_passed: legacyStep,
    url: legacyStep,

    github: () =>
        "This app has no repository linked. Call get_github_connection for the repositories Autonoma can " +
        "see, then link_repository with the full 'owner/repo' name - that completes the GitHub step itself.",
    preview_environment: () =>
        "This app has not committed to how it gets its previews. Call select_preview_path with " +
        "'autonoma-hosted' - the default - unless the user has asked to use their own deploys.",
    previewkit_configuring: () =>
        "Autonoma hosts this app's previews and none has been deployed yet. Save a valid config with " +
        "apply_config, call trigger_deploy, and poll get_session_status until diagnostics.status is `ready`.",
    previewkit_deploying: previewkitDeployNextStep,
    existing_deploys_configuring: () =>
        "This app's previews come from its own pipeline and that wiring is not confirmed. On Vercel: " +
        "get_vercel_setup, link_vercel_project, then select_vercel_deployment. Anywhere else: " +
        "get_signal_setup, make their pipeline send the signed call, poll get_signal_status until a signal " +
        "lands, then confirm_signal_setup.",
    existing_deploys_waiting: () =>
        "The wiring is confirmed but no signed deployment signal has arrived, so Autonoma has no preview " +
        "URL to test against. Trigger a real deploy on their pipeline - not a hand-written curl - and poll " +
        "get_signal_status until `signalReceived` is true.",

    // Reachable only if the preview stopped being ready between the step read and
    // this message, since go_live acts on these rather than refusing.
    preview_verified: () =>
        "This app's preview was verified, so go_live takes it live once the preview is up again. " +
        "Poll get_session_status until diagnostics.status is `ready`.",
    diff_trigger: () =>
        "This app is one call from live: go_live advances it as soon as its preview is ready. " +
        "Poll get_session_status until diagnostics.status is `ready`.",
    completed: () => "This app is already live; nothing here moves it further.",
};

function nextStepFor(step: OnboardingStep, previewStatus: PreviewDiagnosticsStatus): string {
    return NEXT_STEP[step](previewStatus);
}

function previewkitDeployNextStep(previewStatus: PreviewDiagnosticsStatus): string {
    if (previewStatus === "failed") {
        return (
            "The last deploy FAILED, so waiting will not clear it. Read `recentLogs` from get_session_status for " +
            "the failing step, fix the config with apply_config (or ask for a missing secret with request_env), " +
            "then trigger_deploy again."
        );
    }
    return (
        "A preview is deploying but has not reported ready. Poll get_session_status roughly every 30s until " +
        "diagnostics.status is `ready`, then exercise the app against the preview URL yourself - a passing health " +
        "check does not mean the app works."
    );
}

/**
 * The refusal for an app whose preview was verified once but is not up right
 * now. Distinct from {@link describeUnfinishedStep}: nothing is missing from the
 * setup, so the agent should wait out a rebuild rather than reconfigure.
 */
export function describeUnverifiedPreview(previewStatus: PreviewDiagnosticsStatus): string {
    return (
        `This app reached a verified preview, but its preview is \`${previewStatus}\` right now, so onboarding will ` +
        "not advance - going live would point pull-request reviews at an environment that is not up. Nothing is " +
        "missing from the setup: poll get_session_status until diagnostics.status is `ready` (if it is `failed`, " +
        "read `recentLogs`, fix the cause and redeploy), then call go_live again."
    );
}

/** What being live means from here, which differs by how the app gets its previews. */
export function describeWentLive(mode: OnboardingPreviewEnvironmentMode | undefined): string {
    if (mode === "existing_deploys") {
        return (
            "This app is live: Autonoma will review a pull request against the preview their pipeline builds for " +
            "it. That depends on the signed call carrying `branch` and `prNumber` TOGETHER - one carrying neither " +
            "is recorded as a main-branch deploy and reviews nothing - and Autonoma cannot verify that until a real " +
            "PR signal arrives, so this went live on trust and confirms itself on the first one. Open a pull " +
            "request and check get_signal_status reports `prReviewsConfirmed`. The Autonoma SDK handler and the " +
            "scenario recipes are separate work that going live does not depend on; keep going on those if they " +
            "are not done."
        );
    }
    return (
        "This app is live: Autonoma deploys a preview for every pull request and reviews it automatically, with " +
        "nothing further to wire. Open a pull request to see the first review. The Autonoma SDK handler and the " +
        "scenario recipes are separate work that going live does not depend on; keep going on those if they are " +
        "not done."
    );
}

/**
 * The answer to a second go_live on an app that is already live. Not
 * an error - a retrying agent should read "done" and move on - but explicitly
 * not a no-op it can repeat to force anything, since the reason PR reviews are
 * missing is never the onboarding step at that point.
 */
export function describeAlreadyLive(): string {
    return (
        "Already live - onboarding is `completed` for this app and this call changed nothing. If pull requests are " +
        "not being reviewed, the onboarding step is not the cause: check the preview itself with get_session_status " +
        "(Autonoma-hosted) or get_signal_status (their own pipeline)."
    );
}
