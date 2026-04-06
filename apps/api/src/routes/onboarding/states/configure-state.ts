import { OnboardingState } from "./onboarding-state";

export class ConfigureState extends OnboardingState {
    readonly step = "configure" as const;

    override async markAgentConnected(): Promise<void> {
        this.logger.info("Marking agent connected");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "working", agentConnectedAt: new Date() },
        });
    }
}
