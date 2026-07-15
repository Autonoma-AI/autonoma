import { type PrismaClient, VercelInstallationStatus } from "@autonoma/db";
import { BadRequestError, ConflictError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import { env } from "../../env";
import { applyVercelProtectionBypassHeader } from "../../vercel-marketplace/vercel-helpers";
import type { OnboardingManagerOptions } from "./onboarding-dependencies";
import { OnboardingApplicationNotFoundError } from "./states/onboarding-state";

export interface AvailableVercelProject {
    id: string;
    name: string;
}

export interface ListAvailableVercelProjectsResult {
    /** False when the org has never installed the Vercel Marketplace integration at all. */
    connected: boolean;
    projects: AvailableVercelProject[];
    /** "Connect a new Vercel project" redirect target, or undefined if VERCEL_INTEGRATION_SLUG isn't configured. */
    connectUrl: string | undefined;
    /** Set when this application already has a Vercel project linked. */
    linkedProject: AvailableVercelProject | undefined;
}

function buildVercelConnectUrl(): string | undefined {
    if (env.VERCEL_INTEGRATION_SLUG == null) return undefined;
    return `https://vercel.com/integrations/${env.VERCEL_INTEGRATION_SLUG}/new`;
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
            select: { id: true },
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
}
