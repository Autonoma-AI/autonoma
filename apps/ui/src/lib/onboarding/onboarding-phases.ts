import type { OnboardingStep } from "./onboarding-steps";

export interface OnboardingPhase {
    id: string;
    label: string;
    activeSteps: OnboardingStep[];
}

/**
 * The three user-facing onboarding phases. Both the onboarding sidebar
 * (step-progress) and the resume hub read from this single source so the
 * phase names and counts they show a user stay consistent.
 */
export const ONBOARDING_PHASES: OnboardingPhase[] = [
    { id: "create-app", label: "Create app", activeSteps: ["add-app"] },
    {
        id: "preview",
        label: "Config previews",
        activeSteps: ["preview-environment", "previewkit-config", "existing-deploys", "deploy-verify"],
    },
    { id: "finish", label: "Finish", activeSteps: ["diff-trigger", "complete"] },
];
