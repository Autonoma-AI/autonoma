import { OnboardingState } from "./onboarding-state";

export class CompletedState extends OnboardingState {
    readonly step = "completed" as const;
}
