import type { PrismaClient } from "@autonoma/db";
import type {
    ArtifactStatus,
    UpdateSetupBody,
    UploadArtifactsBody,
    UploadScenarioRecipeVersionsBody,
} from "@autonoma/types";
import type { ApplicationSetupService } from "../../application-setup/application-setup.service";
import type { ApiKeysService } from "../api-keys/api-keys.service";
import { Service } from "../service";
import { computeArtifactStatus } from "./artifact-status";

/** Result of preparing the in-app CLI deepening command: a fresh upload token plus its setup. */
export interface PreparedCliSetup {
    apiKey: string;
    setupId: string;
}

export class ApplicationSetupsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly applicationSetup: ApplicationSetupService,
        private readonly apiKeys: ApiKeysService,
    ) {
        super();
    }

    async getLatest(organizationId: string, applicationId: string) {
        return await this.db.applicationSetup.findFirst({
            where: { applicationId, organizationId },
            orderBy: { createdAt: "desc" },
            include: {
                events: { orderBy: { createdAt: "asc" } },
            },
        });
    }

    async getById(setupId: string, organizationId: string) {
        return await this.db.applicationSetup.findFirst({
            where: { id: setupId, organizationId },
            include: {
                events: { orderBy: { createdAt: "asc" } },
            },
        });
    }

    /**
     * Per-artifact upload progress for the onboarding "Setup" step. The UI polls
     * this every 5s while the planner CLI runs and auto-advances once `complete`
     * flips (the CLI marks the setup `completed` after its final upload).
     */
    async artifactStatus(organizationId: string, applicationId: string): Promise<ArtifactStatus> {
        this.logger.info("Fetching artifact status", { extra: { applicationId, organizationId } });
        return computeArtifactStatus(this.db, applicationId, organizationId);
    }

    /**
     * Mint an upload token + setup so the Finish setup tab can render a working
     * planner CLI command (`AUTONOMA_API_TOKEN` + `AUTONOMA_GENERATION_ID`). The
     * key is the only piece that genuinely needs an API key; the in-app admin
     * upload path uses session-authed tRPC and does not.
     */
    async prepareCliSetup(userId: string, organizationId: string, applicationId: string): Promise<PreparedCliSetup> {
        this.logger.info("Preparing CLI setup", { extra: { applicationId, organizationId } });
        const apiKey = await this.apiKeys.create(userId, organizationId, `finish-setup-${applicationId}`);
        const setup = await this.applicationSetup.createSetup(userId, organizationId, applicationId);
        return { apiKey: apiKey.key, setupId: setup.id };
    }

    async uploadScenarioRecipeVersions(
        setupId: string,
        organizationId: string,
        body: UploadScenarioRecipeVersionsBody,
    ) {
        this.logger.info("Uploading scenario recipe versions", { extra: { setupId, organizationId } });
        return await this.applicationSetup.uploadScenarioRecipeVersions(setupId, organizationId, body);
    }

    async uploadArtifacts(setupId: string, organizationId: string, body: UploadArtifactsBody) {
        this.logger.info("Uploading setup artifacts", { extra: { setupId, organizationId } });
        await this.applicationSetup.uploadArtifacts(setupId, organizationId, body);
        return { ok: true as const };
    }

    async updateSetup(setupId: string, organizationId: string, body: UpdateSetupBody) {
        this.logger.info("Updating setup", { extra: { setupId, organizationId } });
        await this.applicationSetup.updateSetup(setupId, organizationId, body);
        return { ok: true as const };
    }
}
