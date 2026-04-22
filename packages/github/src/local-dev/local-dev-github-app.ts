import { type Logger, logger } from "@autonoma/logger";
import type { GitHubApp } from "../github-app";
import type { GitHubInstallationClient } from "../github-installation-client";
import { LocalDevGitHubInstallationClient } from "./local-dev-github-installation-client";

export class LocalDevGitHubApp implements GitHubApp {
    readonly slug = "local-dev-app";

    private readonly logger: Logger;
    private readonly client: LocalDevGitHubInstallationClient;

    constructor() {
        this.logger = logger.child({ name: this.constructor.name });
        this.client = new LocalDevGitHubInstallationClient();
        this.logger.info("Initialized local-dev GitHub app", { slug: this.slug });
    }

    async getInstallationClient(installationId: number): Promise<GitHubInstallationClient> {
        this.logger.info("Returning local-dev installation client", { installationId });
        return this.client;
    }

    async deleteInstallation(installationId: number): Promise<void> {
        this.logger.info("Local-dev deleteInstallation (no-op)", { installationId });
    }

    async verifyWebhook(_body: string, _signature: string): Promise<boolean> {
        throw new Error("verifyWebhook not supported in LOCAL_DEV mode");
    }
}
