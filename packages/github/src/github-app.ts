import { App } from "@octokit/app";
import type { GitHubInstallationClient } from "./github-installation-client";
import { OctokitGitHubInstallationClient } from "./github-installation-client";

export interface GitHubAppCredentials {
    appId: string;
    privateKey: string;
    webhookSecret: string;
    appSlug: string;
}

export interface GitHubAppInstallation {
    id: number;
    accountLogin: string;
    accountType: string;
}

export interface GitHubApp {
    readonly slug: string;
    listInstallations(): Promise<GitHubAppInstallation[]>;
    getInstallationClient(installationId: number): Promise<GitHubInstallationClient>;
    deleteInstallation(installationId: number): Promise<void>;
    verifyWebhook(body: string, signature: string): Promise<boolean>;
}

/** Creates installation-scoped GitHub clients from a GitHub App. */
export class OctokitGitHubApp implements GitHubApp {
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

    async listInstallations(): Promise<GitHubAppInstallation[]> {
        const installations: GitHubAppInstallation[] = [];
        let page = 1;

        while (true) {
            const { data } = await this.app.octokit.request("GET /app/installations", { per_page: 100, page });

            installations.push(
                ...data.map((installation) => {
                    const account = installation.account as { login?: string; type?: string } | null;
                    return {
                        id: installation.id,
                        accountLogin: account?.login ?? "unknown",
                        accountType: account?.type ?? "unknown",
                    };
                }),
            );

            if (data.length < 100) break;
            page++;
        }

        return installations;
    }

    async getInstallationClient(installationId: number): Promise<GitHubInstallationClient> {
        const octokit = await this.app.getInstallationOctokit(installationId);
        return new OctokitGitHubInstallationClient(octokit);
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
