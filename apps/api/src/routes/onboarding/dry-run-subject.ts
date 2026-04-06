import type { PrismaClient } from "@autonoma/db";
import type { ScenarioApplicationData, ScenarioSubject } from "@autonoma/scenario";
import { DryRunSubjectMisuseError, OnboardingWebhookNotConfiguredError } from "./states/onboarding-state";

export class DryRunSubject implements ScenarioSubject {
    constructor(
        private readonly db: PrismaClient,
        private readonly applicationId: string,
    ) {}

    async getScenarioId(): Promise<string> {
        throw new DryRunSubjectMisuseError("getScenarioId");
    }

    async getApplicationData(): Promise<ScenarioApplicationData> {
        const app = await this.db.application.findUniqueOrThrow({
            where: { id: this.applicationId },
            select: { id: true, organizationId: true, webhookUrl: true, signingSecretEnc: true },
        });

        if (app.webhookUrl == null || app.signingSecretEnc == null) {
            throw new OnboardingWebhookNotConfiguredError(this.applicationId);
        }

        return {
            applicationId: app.id,
            organizationId: app.organizationId,
            webhookUrl: app.webhookUrl,
            signingSecretEnc: app.signingSecretEnc,
        };
    }

    async linkInstance(_instanceId: string): Promise<void> {
        // No-op for dry runs
    }
}
