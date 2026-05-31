import type { GitHubApp, GitHubAppInstallation } from "../github-app";
import type { GitHubInstallationClient } from "../github-installation-client";
import { FakeGitHubInstallationClient } from "./fake-github-installation-client";

export class FakeGitHubApp implements GitHubApp {
    readonly slug: string = "fake-app";
    readonly defaultClient: FakeGitHubInstallationClient;
    readonly deletedInstallations: number[] = [];

    private clients: Map<number, FakeGitHubInstallationClient> = new Map();
    private installations: Map<number, GitHubAppInstallation> = new Map([
        [1, { id: 1, accountLogin: "fake-org", accountType: "Organization" }],
    ]);

    constructor(defaultClient?: FakeGitHubInstallationClient) {
        this.defaultClient = defaultClient ?? new FakeGitHubInstallationClient();
    }

    async listInstallations(): Promise<GitHubAppInstallation[]> {
        return [...this.installations.values()].sort((a, b) => a.id - b.id);
    }

    async getInstallationClient(installationId: number): Promise<GitHubInstallationClient> {
        return this.clients.get(installationId) ?? this.defaultClient;
    }

    async deleteInstallation(installationId: number): Promise<void> {
        this.deletedInstallations.push(installationId);
    }

    async verifyWebhook(_body: string, _signature: string): Promise<boolean> {
        return true;
    }

    setClient(installationId: number, client: FakeGitHubInstallationClient): void {
        this.clients.set(installationId, client);
        if (!this.installations.has(installationId)) {
            this.installations.set(installationId, {
                id: installationId,
                accountLogin: `fake-org-${installationId}`,
                accountType: "Organization",
            });
        }
    }
}
