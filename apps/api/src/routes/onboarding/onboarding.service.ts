import { Service } from "../service";
import type { OnboardingManager } from "./onboarding-manager";

export class OnboardingService extends Service {
    constructor(readonly manager: OnboardingManager) {
        super();
    }

    async getState(applicationId: string) {
        return this.manager.getState(applicationId);
    }

    async getLogs(applicationId: string) {
        return this.manager.getLogs(applicationId);
    }

    async startConfigure(applicationId: string) {
        return this.manager.startConfigure(applicationId);
    }

    async markAgentConnected(applicationId: string) {
        return this.manager.markAgentConnected(applicationId);
    }

    async startScenarioDryRun(applicationId: string) {
        return this.manager.startScenarioDryRun(applicationId);
    }

    async setUrl(applicationId: string, organizationId: string, productionUrl: string) {
        return this.manager.setUrl(applicationId, organizationId, productionUrl);
    }

    async configureAndDiscoverScenarios(
        applicationId: string,
        organizationId: string,
        webhookUrl: string,
        signingSecret: string,
    ) {
        return this.manager.configureAndDiscoverScenarios(applicationId, organizationId, webhookUrl, signingSecret);
    }

    async runScenarioDryRun(applicationId: string, scenarioId: string) {
        return this.manager.runScenarioDryRun(applicationId, scenarioId);
    }

    async complete(applicationId: string) {
        return this.manager.complete(applicationId);
    }

    async reset(applicationId: string) {
        return this.manager.reset(applicationId);
    }
}
