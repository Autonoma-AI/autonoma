import type { OnboardingPreviewEnvironmentMode } from "@autonoma/db";
import { OnboardingState } from "./onboarding-state";

export class PreviewEnvironmentState extends OnboardingState {
    readonly step = "preview_environment" as const;

    override async selectPreviewEnvironmentMode(mode: OnboardingPreviewEnvironmentMode): Promise<void> {
        this.logger.info("Selecting preview environment mode", { mode });
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: {
                step: mode === "previewkit" ? "previewkit_configuring" : "existing_deploys_configuring",
                previewEnvironmentMode: mode,
                previewUrl: null,
                previewVerificationStatus: "idle",
            },
        });
    }
}
