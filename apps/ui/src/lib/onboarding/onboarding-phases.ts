import type { OnboardingViewStep } from "./onboarding-steps";

export interface OnboardingPhase {
    id: string;
    label: string;
    activeSteps: OnboardingViewStep[];
}

/**
 * The user-facing onboarding phases, in order. Onboarding runs as one flow from
 * connecting a repo to a dry run that provisions real test data, so the phases
 * cover all of it - the post-go-live steps are part of the same journey, not a
 * separate "finish setup" the user opts into afterwards.
 *
 * There is no phase between the preview and the test data: verifying a preview is what
 * takes an app live, so a phase in between could only restate that and wait for a click.
 *
 * `complete` belongs to no phase on purpose: it is the screen shown once every
 * phase is behind you, so the progress readouts report 100% rather than parking
 * a finished app inside its own last phase.
 */
export const ONBOARDING_PHASES: OnboardingPhase[] = [
    { id: "create-app", label: "Create app", activeSteps: ["add-app"] },
    {
        id: "preview",
        label: "Config previews",
        activeSteps: ["preview-environment", "previewkit-config", "existing-deploys", "deploy-verify"],
    },
    { id: "test-data", label: "Test data", activeSteps: ["cli", "sdk", "dry-run"] },
];
