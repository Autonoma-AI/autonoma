import type { PreviewkitConfigSecrets } from "@autonoma/types";
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

    async completeGithub(applicationId: string, organizationId: string) {
        return this.manager.completeGithub(applicationId, organizationId);
    }

    async selectPreviewEnvironmentMode(
        applicationId: string,
        organizationId: string,
        mode: "previewkit" | "existing_deploys",
    ) {
        return this.manager.selectPreviewEnvironmentMode(applicationId, organizationId, mode);
    }

    async confirmExistingDeploysSetup(applicationId: string, organizationId: string) {
        return this.manager.confirmExistingDeploysSetup(applicationId, organizationId);
    }

    async triggerPreviewkitMainDeploy(applicationId: string, organizationId: string) {
        return this.manager.triggerPreviewkitMainDeploy(applicationId, organizationId);
    }

    async getPreviewkitConfig(applicationId: string, organizationId: string) {
        return this.manager.getPreviewkitConfig(applicationId, organizationId);
    }

    async savePreviewkitConfig(
        applicationId: string,
        organizationId: string,
        document: unknown,
        dependencyDocuments?: Array<{ repo: string; document: unknown }>,
        secrets?: PreviewkitConfigSecrets,
    ) {
        return this.manager.savePreviewkitConfig(applicationId, organizationId, document, dependencyDocuments, secrets);
    }

    async getDeploymentSignalStatus(applicationId: string, organizationId: string) {
        return this.manager.getDeploymentSignalStatus(applicationId, organizationId);
    }

    async validatePreviewkitConfig(
        applicationId: string,
        organizationId: string,
        document: unknown,
        githubRepositoryId?: number,
    ) {
        return this.manager.validatePreviewkitConfig(applicationId, organizationId, document, githubRepositoryId);
    }

    async listDockerfiles(applicationId: string, organizationId: string, githubRepositoryId?: number) {
        return this.manager.listDockerfiles(applicationId, organizationId, githubRepositoryId);
    }

    async listPreviewkitSecrets(applicationId: string, organizationId: string, appName: string) {
        return this.manager.listPreviewkitSecrets(applicationId, organizationId, appName);
    }

    async upsertPreviewkitSecrets(
        applicationId: string,
        organizationId: string,
        appName: string,
        items: Array<{ key: string; value: string }>,
    ) {
        return this.manager.upsertPreviewkitSecrets(applicationId, organizationId, appName, items);
    }

    async deletePreviewkitSecret(applicationId: string, organizationId: string, appName: string, key: string) {
        return this.manager.deletePreviewkitSecret(applicationId, organizationId, appName, key);
    }

    async getPreviewReadiness(applicationId: string, organizationId: string) {
        return this.manager.getPreviewReadiness(applicationId, organizationId);
    }

    async completePreviewOnboarding(applicationId: string, organizationId: string) {
        return this.manager.completePreviewOnboarding(applicationId, organizationId);
    }

    async goLive(applicationId: string, organizationId: string) {
        return this.manager.goLive(applicationId, organizationId);
    }

    async configureAndDiscoverScenarios(
        applicationId: string,
        organizationId: string,
        webhookUrl: string,
        signingSecret: string,
        webhookHeaders?: Record<string, string>,
    ) {
        return this.manager.configureAndDiscoverScenarios(
            applicationId,
            organizationId,
            webhookUrl,
            signingSecret,
            webhookHeaders,
        );
    }

    async listAvailableVercelProjects(applicationId: string, organizationId: string) {
        return this.manager.listAvailableVercelProjects(applicationId, organizationId);
    }

    async linkVercelProject(applicationId: string, organizationId: string, vercelProjectId: string) {
        return this.manager.linkVercelProject(applicationId, organizationId, vercelProjectId);
    }

    async unlinkVercelProject(applicationId: string, organizationId: string) {
        return this.manager.unlinkVercelProject(applicationId, organizationId);
    }

    async prepareSdkTarget(applicationId: string, organizationId: string, targetId: string) {
        return this.manager.prepareSdkTarget(applicationId, organizationId, targetId);
    }

    async configureAndDiscoverSdkTarget(
        applicationId: string,
        organizationId: string,
        targetId: string,
        allowSelfHeal: boolean,
    ) {
        return this.manager.configureAndDiscoverSdkTarget(applicationId, organizationId, targetId, allowSelfHeal);
    }

    async runScenarioDryRun(applicationId: string, organizationId: string, scenarioId: string, targetId?: string) {
        return this.manager.runScenarioDryRun(applicationId, organizationId, scenarioId, targetId);
    }

    async listSdkDryRunTargets(applicationId: string, organizationId: string) {
        return this.manager.listSdkDryRunTargets(applicationId, organizationId);
    }
}
