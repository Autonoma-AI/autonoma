import { App } from "@octokit/app";
import { GitHubInstallationClient } from "./github-installation-client";

export interface GitHubAppCredentials {
    appId: string;
    privateKey: string;
    webhookSecret: string;
    appSlug: string;
}

/** Creates installation-scoped GitHub clients from a GitHub App. */
export class GitHubApp {
    private readonly app: App;
    public readonly slug: string;

    constructor(credentials: GitHubAppCredentials) {
        this.slug = credentials.appSlug;
        this.app = new App({
            appId: credentials.appId,
            privateKey: credentials.privateKey,
            webhooks: { secret: credentials.webhookSecret },
        });
    }

    async getInstallationClient(installationId: number): Promise<GitHubInstallationClient> {
        const octokit = await this.app.getInstallationOctokit(installationId);
        return new GitHubInstallationClient(octokit);
    }

    async deleteInstallation(installationId: number): Promise<void> {
        const octokit = await this.app.getInstallationOctokit(installationId);
        await octokit.request("DELETE /app/installations/{installation_id}", {
            installation_id: installationId,
        });
    }

    async verifyWebhook(body: string, signature: string): Promise<boolean> {
        return this.app.webhooks.verify(body, signature);
    }
}
