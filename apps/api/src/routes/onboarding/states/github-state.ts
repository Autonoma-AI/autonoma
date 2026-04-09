import { OnboardingState } from "./onboarding-state";

export class GitHubState extends OnboardingState {
    readonly step = "github" as const;

    override async completeGithub(): Promise<void> {
        this.logger.info("Completing GitHub step");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "completed", completedAt: new Date() },
        });
    }
}
