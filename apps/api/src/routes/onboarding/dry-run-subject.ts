import type { PrismaClient } from "@autonoma/db";
import type { ScenarioSubject } from "@autonoma/scenario";
import { OnboardingSdkNotConfiguredError } from "./states/onboarding-state";

export class DryRunSubject implements ScenarioSubject {
    constructor(
        private readonly db: PrismaClient,
        private readonly applicationId: string,
    ) {}

    async resolveDeployment(): Promise<{ applicationId: string; deploymentId: string }> {
        const app = await this.db.application.findUniqueOrThrow({
            where: { id: this.applicationId },
            select: {
                id: true,
                signingSecretEnc: true,
                mainBranch: {
                    select: { deployment: { select: { id: true, webhookUrl: true } } },
                },
            },
        });

        const deployment = app.mainBranch?.deployment;
        if (deployment?.webhookUrl == null || app.signingSecretEnc == null) {
            throw new OnboardingSdkNotConfiguredError(this.applicationId);
        }

        return { applicationId: app.id, deploymentId: deployment.id };
    }
}
