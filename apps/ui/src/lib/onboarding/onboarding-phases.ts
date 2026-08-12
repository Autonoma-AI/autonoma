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
    // Named for what the step turns on, not for "going live": the flow continues
    // past it, and a phase called "Go live" sitting mid-rail reads as the finish
    // line to someone who still has three steps in front of them.
    { id: "pr-reviews", label: "PR reviews", activeSteps: ["diff-trigger"] },
    { id: "test-data", label: "Test data", activeSteps: ["cli", "sdk", "dry-run"] },
];
