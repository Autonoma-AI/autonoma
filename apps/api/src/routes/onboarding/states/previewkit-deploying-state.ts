import { OnboardingState } from "./onboarding-state";

export class PreviewkitDeployingState extends OnboardingState {
    readonly step = "previewkit_deploying" as const;
}
