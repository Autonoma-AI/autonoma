import { BadRequestError } from "@autonoma/errors";
import { OnboardingState } from "./onboarding-state";

export class WorkingState extends OnboardingState {
    readonly step = "working" as const;

    override async startScenarioDryRun(): Promise<void> {
        this.logger.info("Starting scenario dry run step");

        const recipeCount = await this.db.scenario.count({
            where: {
                application: { id: this.applicationId },
                isDisabled: false,
                activeRecipeVersionId: { not: null },
            },
        });
        if (recipeCount === 0) {
            throw new BadRequestError(
                "Cannot start scenario dry run: no scenario recipes have been uploaded for this application",
            );
        }

        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "webhook_configuring" },
        });
    }
}
