import { type PrismaClient, VercelInstallationStatus } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import { env } from "../../env";
import { applyVercelProtectionBypassHeader, applyVercelSharedSecretEnv } from "../../vercel-marketplace/vercel-helpers";
import {
    getVercelDeployment as getVercelDeploymentFromApi,
    listVercelDeployments as listVercelDeploymentsFromApi,
    redeployVercelDeployment as redeployVercelDeploymentFromApi,
    type VercelDeploymentSummary,
} from "../../vercel-marketplace/vercel-project-api";
import type { OnboardingManagerOptions } from "./onboarding-dependencies";
import { writePreviewUrl } from "./preview-readiness";
import { buildSdkUrl } from "./sdk-url";
import { OnboardingApplicationNotFoundError } from "./states/onboarding-state";

const VERCEL_READY_STATE = "READY";

export interface VercelRedeployResult {
    deploymentId: string;
    url: string;
    readyState: string;
}

export interface VercelDeploymentStatusResult {
    readyState: string;
    url: string;
    ready: boolean;
}

export interface AvailableVercelProject {
    id: string;
    name: string;
}

export interface ListAvailableVercelProjectsResult {
    /** False when the org has never installed the Vercel Marketplace integration at all. */
    connected: boolean;
    projects: AvailableVercelProject[];
    /** "Connect a new Vercel project" redirect target, or undefined if VERCEL_INTEGRATION_URL isn't configured. */
    connectUrl: string | undefined;
    /** Set when this application already has a Vercel project linked. */
    linkedProject: AvailableVercelProject | undefined;
}

function buildVercelConnectUrl(): string | undefined {
    return env.VERCEL_INTEGRATION_URL;
}

export class OnboardingVercelCapabilityService {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly options: OnboardingManagerOptions,
    ) {
        this.logger = logger.child({ name: "OnboardingVercelCapabilityService" });
    }

    private getEncryptionHelper() {
        const getHelper = this.options.getVercelEncryptionHelper;
        if (getHelper == null) {
            throw new BadRequestError("Vercel integration is not configured on this server");
        }
        return getHelper();
    }

    async listAvailableVercelProjects(
        applicationId: string,
        organizationId: string,
    ): Promise<ListAvailableVercelProjectsResult> {
        this.logger.info("Listing available Vercel projects", { applicationId, organizationId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true },
        });
        if (app == null) throw new OnboardingApplicationNotFoundError(applicationId);

        const connectUrl = buildVercelConnectUrl();

        const installation = await this.db.vercelInstallation.findFirst({
            where: { organizationId, status: VercelInstallationStatus.active },
            select: { id: true },
        });
        if (installation == null) {
            return { connected: false, projects: [], connectUrl, linkedProject: undefined };
        }

        const existingConnection = await this.db.vercelProjectConnection.findFirst({
            where: { applicationId },
            select: { project: { select: { vercelProjectId: true, name: true } } },
        });
        if (existingConnection != null) {
            this.logger.info("Application already has a linked Vercel project", {
                applicationId,
                vercelProjectId: existingConnection.project.vercelProjectId,
            });
            return {
                connected: true,
                projects: [],
                connectUrl,
                linkedProject: {
                    id: existingConnection.project.vercelProjectId,
                    name: existingConnection.project.name,
                },
            };
        }

        const unlinkedProjects = await this.db.vercelProject.findMany({
            where: { vercelInstallationId: installation.id, connection: null },
            select: { vercelProjectId: true, name: true },
        });
        const projects = unlinkedProjects.map((p) => ({ id: p.vercelProjectId, name: p.name }));

        this.logger.info("Listed available Vercel projects", { applicationId, count: projects.length });
        return { connected: true, projects, connectUrl, linkedProject: undefined };
    }

    async linkVercelProject(applicationId: string, organizationId: string, vercelProjectId: string): Promise<void> {
        this.logger.info("Linking Vercel project", { applicationId, vercelProjectId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true },
        });
        if (app == null) throw new OnboardingApplicationNotFoundError(applicationId);

        const installation = await this.db.vercelInstallation.findFirst({
            where: { organizationId, status: VercelInstallationStatus.active },
            select: { id: true, accessTokenEnc: true },
        });
        if (installation == null) {
            throw new BadRequestError("No active Vercel installation for this organization");
        }

        const project = await this.db.vercelProject.findUnique({
            where: { vercelProjectId_vercelInstallationId: { vercelProjectId, vercelInstallationId: installation.id } },
            select: {
                id: true,
                protectionBypassSecretEnc: true,
                connection: { select: { applicationId: true } },
            },
        });
        if (project == null) {
            throw new BadRequestError("Vercel project not found - it must be connected on Vercel's side first");
        }
        if (project.connection != null) {
            throw new ConflictError(
                `Vercel project is already linked to application ${project.connection.applicationId}`,
            );
        }

        const connection = await this.db.vercelProjectConnection.create({
            data: { projectId: project.id, applicationId: app.id },
            select: { id: true },
        });

        if (project.protectionBypassSecretEnc != null) {
            const secret = this.getEncryptionHelper().decrypt(project.protectionBypassSecretEnc);
            await applyVercelProtectionBypassHeader(app.id, secret);
        }

        if (installation.accessTokenEnc != null) {
            const accessToken = this.getEncryptionHelper().decrypt(installation.accessTokenEnc);
            await applyVercelSharedSecretEnv(app.id, vercelProjectId, undefined, accessToken);
        } else {
            this.logger.warn("Vercel installation has no access token, skipping shared secret env sync", {
                applicationId,
                vercelProjectId,
            });
        }

        this.logger.info("Linked Vercel project", { applicationId, vercelProjectId, connectionId: connection.id });
    }

    async unlinkVercelProject(applicationId: string, organizationId: string): Promise<void> {
        this.logger.info("Unlinking Vercel project", { applicationId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true },
        });
        if (app == null) throw new OnboardingApplicationNotFoundError(applicationId);

        const { count } = await this.db.vercelProjectConnection.deleteMany({ where: { applicationId } });
        if (count === 0) {
            throw new BadRequestError("Application has no linked Vercel project");
        }

        this.logger.info("Unlinked Vercel project", { applicationId });
    }

    async listVercelDeployments(applicationId: string, organizationId: string): Promise<VercelDeploymentSummary[]> {
        this.logger.info("Listing Vercel deployments", { applicationId, organizationId });

        const { vercelProjectId, accessToken } = await this.getLinkedProjectAccess(applicationId, organizationId);
        this.logger.info("Resolved linked Vercel project for deployment listing", { applicationId, vercelProjectId });
        const deployments = await listVercelDeploymentsFromApi(vercelProjectId, undefined, accessToken);

        if (deployments.length === 0) {
            this.logger.warn("No ready Vercel deployments found for project", { applicationId, vercelProjectId });
        } else {
            this.logger.info("Listed Vercel deployments", {
                applicationId,
                vercelProjectId,
                count: deployments.length,
            });
        }
        return deployments;
    }

    /**
     * Redeploys a chosen Vercel deployment so it rebuilds with the project's
     * current env vars - most importantly the `AUTONOMA_SHARED_SECRET` we inject
     * on link, which only takes effect on new builds. The redeploy gets a NEW id
     * + URL, so this returns them for the caller to poll and then commit via
     * `selectVercelDeployment`. Re-fetches the deployment list rather than
     * trusting a client-supplied id, so a stale or tampered dropdown selection
     * can't redeploy an arbitrary deployment. Does NOT write the preview URL -
     * the new deployment is still building.
     */
    async redeployVercelDeployment(
        applicationId: string,
        organizationId: string,
        vercelDeploymentId: string,
    ): Promise<VercelRedeployResult> {
        this.logger.info("Redeploying Vercel deployment", { applicationId, vercelDeploymentId });

        const { vercelProjectId, projectName, accessToken } = await this.getLinkedProjectAccess(
            applicationId,
            organizationId,
        );
        const deployments = await listVercelDeploymentsFromApi(vercelProjectId, undefined, accessToken);
        const deployment = deployments.find((candidate) => candidate.id === vercelDeploymentId);
        if (deployment == null) {
            throw new NotFoundError("Vercel deployment not found for this project");
        }

        const redeployed = await redeployVercelDeploymentFromApi(projectName, vercelDeploymentId, undefined, accessToken);

        this.logger.info("Redeployed Vercel deployment for onboarding preview", {
            applicationId,
            vercelDeploymentId,
            newDeploymentId: redeployed.id,
        });
        return { deploymentId: redeployed.id, url: redeployed.url, readyState: redeployed.readyState };
    }

    /** Current build state of a (re)deployed Vercel deployment, for the UI's readiness poll. */
    async getVercelDeploymentStatus(
        applicationId: string,
        organizationId: string,
        vercelDeploymentId: string,
    ): Promise<VercelDeploymentStatusResult> {
        this.logger.info("Fetching Vercel deployment status", { applicationId, vercelDeploymentId });

        const { accessToken } = await this.getLinkedProjectAccess(applicationId, organizationId);
        const deployment = await getVercelDeploymentFromApi(vercelDeploymentId, undefined, accessToken);

        return {
            readyState: deployment.readyState,
            url: deployment.url,
            ready: deployment.readyState === VERCEL_READY_STATE,
        };
    }

    /**
     * Commits a READY (re)deployed Vercel deployment as the onboarding preview
     * URL, bypassing the manual CI-signal wait entirely. The UI only calls this
     * once its readiness poll reports READY; we re-read the deployment server-side
     * (never trusting a client URL) and reject anything not yet ready so the
     * preview target can never point at a still-building deployment.
     */
    async selectVercelDeployment(
        applicationId: string,
        organizationId: string,
        vercelDeploymentId: string,
    ): Promise<void> {
        this.logger.info("Selecting Vercel deployment", { applicationId, vercelDeploymentId });

        const { accessToken } = await this.getLinkedProjectAccess(applicationId, organizationId);
        const deployment = await getVercelDeploymentFromApi(vercelDeploymentId, undefined, accessToken);
        if (deployment.readyState !== VERCEL_READY_STATE) {
            throw new BadRequestError(`Vercel deployment is not ready yet (${deployment.readyState})`);
        }

        await writePreviewUrl(this.db, { applicationId, organizationId, previewUrl: deployment.url });

        this.logger.info("Selected Vercel deployment as onboarding preview", {
            applicationId,
            vercelDeploymentId,
            previewUrl: deployment.url,
        });
    }

    /**
     * Resolves a READY Vercel deployment's SDK endpoint URL (`<url>/api/autonoma`)
     * for the finish-setup SDK validation step. Rejects a non-ready deployment so
     * discovery never runs against a still-building preview.
     */
    async resolveReadyDeploymentSdkUrl(
        applicationId: string,
        organizationId: string,
        vercelDeploymentId: string,
    ): Promise<string> {
        this.logger.info("Resolving ready Vercel deployment SDK URL", { applicationId, vercelDeploymentId });

        const { accessToken } = await this.getLinkedProjectAccess(applicationId, organizationId);
        const deployment = await getVercelDeploymentFromApi(vercelDeploymentId, undefined, accessToken);
        if (deployment.readyState !== VERCEL_READY_STATE) {
            throw new BadRequestError(`Vercel deployment is not ready yet (${deployment.readyState})`);
        }

        return buildSdkUrl(deployment.url);
    }

    /**
     * Note: deliberately does not resolve/return a Vercel `teamId`.
     * `VercelInstallation.vercelAccountId` is the Marketplace OIDC `account_id`
     * (used for our own org resolution), not Vercel's REST API team ID - passing
     * it as `teamId` gets the request rejected with 403 "Not authorized". The
     * installation's access token is already scoped to its team, so omitting
     * `teamId` entirely is both correct and required here. `projectName` is the
     * required `name` in the redeploy body.
     */
    private async getLinkedProjectAccess(
        applicationId: string,
        organizationId: string,
    ): Promise<{ vercelProjectId: string; projectName: string; accessToken: string }> {
        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true },
        });
        if (app == null) throw new OnboardingApplicationNotFoundError(applicationId);

        const connection = await this.db.vercelProjectConnection.findFirst({
            where: { applicationId },
            select: {
                project: {
                    select: {
                        vercelProjectId: true,
                        name: true,
                        installation: { select: { accessTokenEnc: true } },
                    },
                },
            },
        });
        if (connection == null) {
            throw new BadRequestError("No Vercel project linked to this application");
        }
        if (connection.project.installation.accessTokenEnc == null) {
            throw new BadRequestError("Vercel installation has no access token");
        }

        const accessToken = this.getEncryptionHelper().decrypt(connection.project.installation.accessTokenEnc);
        return {
            vercelProjectId: connection.project.vercelProjectId,
            projectName: connection.project.name,
            accessToken,
        };
    }
}
