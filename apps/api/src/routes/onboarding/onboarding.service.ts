import type { PreviewkitConfigSecrets } from "@autonoma/types";
import { Service } from "../service";
import type { OnboardingManager } from "./onboarding-manager";
import type { ScenarioDryRunRequest } from "./onboarding-sdk-capability";

export class OnboardingService extends Service {
    constructor(readonly manager: OnboardingManager) {
        super();
    }

    /**
     * Onboarding state for an app the caller's organization owns.
     *
     * Org-scoped like every write below it, and for the same reason: the row it
     * returns carries this app's preview and production URLs, its last discovery
     * error and its live pairing code. `manager.getState` takes an id alone because
     * its other callers have already authorized - this is the one that has not.
     */
    async getState(applicationId: string, organizationId: string) {
        await this.manager.assertApplicationInOrg(applicationId, organizationId);
        return this.manager.getState(applicationId);
    }

    /**
     * Whether Finish setup is still outstanding, for an app the caller's organization owns.
     *
     * Org-scoped before the read for the same reason `getState` is: whether an application exists
     * at all is not something a caller outside the organization gets to learn.
     */
    async getNavState(applicationId: string, organizationId: string) {
        await this.manager.assertApplicationInOrg(applicationId, organizationId);
        return this.manager.getNavState(applicationId);
    }

    /** The agent activity stream for an app the caller's organization owns. */
    async getLogs(applicationId: string, organizationId: string) {
        await this.manager.assertApplicationInOrg(applicationId, organizationId);
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

    async setDeployBranch(applicationId: string, organizationId: string, branch: string) {
        return this.manager.setDeployBranch(applicationId, organizationId, branch);
    }

    async listDeployBranchOptions(applicationId: string, organizationId: string) {
        return this.manager.listDeployBranchOptions(applicationId, organizationId);
    }

    async getPreviewkitConfig(applicationId: string, organizationId: string) {
        return this.manager.getPreviewkitConfig(applicationId, organizationId);
    }

    async savePreviewkitConfig(
        applicationId: string,
        organizationId: string,
        document: unknown,
        secrets?: PreviewkitConfigSecrets,
    ) {
        return this.manager.savePreviewkitConfig(applicationId, organizationId, document, secrets);
    }

    async getPreviewEnvironmentMode(applicationId: string, organizationId: string) {
        return this.manager.getPreviewEnvironmentMode(applicationId, organizationId);
    }

    async getExternalSignalStatus(applicationId: string, organizationId: string) {
        return this.manager.getExternalSignalStatus(applicationId, organizationId);
    }

    async getDeploymentSignalStatus(applicationId: string, organizationId: string) {
        return this.manager.getDeploymentSignalStatus(applicationId, organizationId);
    }

    async validatePreviewkitConfig(applicationId: string, organizationId: string, document: unknown) {
        return this.manager.validatePreviewkitConfig(applicationId, organizationId, document);
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

    /** Take a verified preview all the way to live, idempotently. */
    async takeLive(applicationId: string, organizationId: string) {
        return this.manager.takeLive(applicationId, organizationId);
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

    async listVercelDeployments(applicationId: string, organizationId: string) {
        return this.manager.listVercelDeployments(applicationId, organizationId);
    }

    async redeployVercelDeployment(applicationId: string, organizationId: string, vercelDeploymentId: string) {
        return this.manager.redeployVercelDeployment(applicationId, organizationId, vercelDeploymentId);
    }

    async getVercelDeploymentStatus(applicationId: string, organizationId: string, vercelDeploymentId: string) {
        return this.manager.getVercelDeploymentStatus(applicationId, organizationId, vercelDeploymentId);
    }

    async selectVercelDeployment(applicationId: string, organizationId: string, vercelDeploymentId: string) {
        return this.manager.selectVercelDeployment(applicationId, organizationId, vercelDeploymentId);
    }

    async discoverVercelDeploymentTarget(
        applicationId: string,
        organizationId: string,
        vercelDeploymentId: string,
        allowRedeploy: boolean,
    ) {
        return this.manager.discoverVercelDeploymentTarget(
            applicationId,
            organizationId,
            vercelDeploymentId,
            allowRedeploy,
        );
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

    async runScenarioDryRun(request: ScenarioDryRunRequest) {
        return this.manager.runScenarioDryRun(request);
    }

    async listSdkDryRunTargets(applicationId: string, organizationId: string) {
        return this.manager.listSdkDryRunTargets(applicationId, organizationId);
    }

    async redeploySdkDryRunTarget(applicationId: string, organizationId: string, targetId: string) {
        return this.manager.redeploySdkDryRunTarget(applicationId, organizationId, targetId);
    }
}
