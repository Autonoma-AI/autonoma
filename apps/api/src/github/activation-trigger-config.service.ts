import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import type { TriggerConfig } from "@autonoma/types";
import { resolveActivationTriggerConfig } from "./activation-trigger-config";
import type { GitHubInstallationService } from "./github-installation.service";

/** A repo's trigger config plus the `owner/repo` name the settings page shows in its header. */
export interface ApplicationTriggerConfigView extends TriggerConfig {
    repoFullName: string;
}

/**
 * Reads and writes an application's {@link ApplicationTriggerConfig} for the analysis-triggers settings page.
 */
export class ActivationTriggerConfigService {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly github: GitHubInstallationService,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /** The application's current trigger config plus its `owner/repo` name. Throws if it is not linked to a repo. */
    async getForApplication(organizationId: string, applicationId: string): Promise<ApplicationTriggerConfigView> {
        this.logger.info("Getting trigger config for application", { organizationId, applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                githubRepositoryId: true,
                triggerConfig: { select: { autoRunOnReadyForReview: true, analysisTriggerLabel: true } },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");
        if (application.githubRepositoryId == null) {
            throw new NotFoundError("Application is not linked to a GitHub repository");
        }

        const repository = await this.github.getRepository(organizationId, application.githubRepositoryId);
        const config = resolveActivationTriggerConfig(application.triggerConfig);
        this.logger.info("Resolved trigger config for application", {
            organizationId,
            applicationId,
            extra: { repoFullName: repository.fullName, ...config },
        });
        return { ...config, repoFullName: repository.fullName };
    }

    /** Upsert the application's trigger config. Returns the persisted values. */
    async updateForApplication(
        organizationId: string,
        applicationId: string,
        input: TriggerConfig,
    ): Promise<TriggerConfig> {
        this.logger.info("Updating trigger config for application", {
            organizationId,
            applicationId,
            extra: { ...input },
        });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const saved = await this.db.applicationTriggerConfig.upsert({
            where: { applicationId },
            create: {
                applicationId,
                autoRunOnReadyForReview: input.autoRunOnReadyForReview,
                analysisTriggerLabel: input.analysisTriggerLabel,
            },
            update: {
                autoRunOnReadyForReview: input.autoRunOnReadyForReview,
                analysisTriggerLabel: input.analysisTriggerLabel,
            },
            select: { autoRunOnReadyForReview: true, analysisTriggerLabel: true },
        });
        this.logger.info("Updated trigger config for application", {
            organizationId,
            applicationId,
            extra: { ...saved },
        });
        return saved;
    }
}
