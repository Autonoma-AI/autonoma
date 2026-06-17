import { OnboardingState } from "./onboarding-state";

export class GitHubState extends OnboardingState {
    readonly step = "github" as const;

    override async completeGithub(): Promise<void> {
        this.logger.info("Completing GitHub step and advancing to preview environment choice");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: {
                step: "preview_environment",
                previewEnvironmentMode: null,
                previewUrl: null,
                previewVerificationStatus: "idle",
            },
        });
    }
}
