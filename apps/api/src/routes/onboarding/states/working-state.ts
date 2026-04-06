import { OnboardingState } from "./onboarding-state";

export class WorkingState extends OnboardingState {
    readonly step = "working" as const;

    override async startScenarioDryRun(): Promise<void> {
        this.logger.info("Starting scenario dry run step");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "scenario_dry_run" },
        });
    }
}
