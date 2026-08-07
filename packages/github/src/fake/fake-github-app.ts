import { GitHubInstallationUnavailableError } from "../github-app";
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

    /**
     * Installation ids GitHub refuses to issue a token for - an installation that was uninstalled
     * without the webhook reaching us, or one belonging to a different GitHub App entirely (every
     * row does, in any environment restored from another environment's database).
     */
    readonly unavailableInstallations: Set<number> = new Set();

    async getInstallationClient(installationId: number): Promise<GitHubInstallationClient> {
        // Deliberately still RETURNS a client for an unavailable installation, because that is what
        // octokit does: `getInstallationOctokit` constructs one without contacting GitHub. The
        // failure only appears when something actually authenticates - which is why a liveness
        // check that merely builds the client silently passes for an installation that is gone.
        const client = this.clients.get(installationId) ?? this.defaultClient;
        if (!this.unavailableInstallations.has(installationId)) return client;

        const unavailable = () => {
            throw new GitHubInstallationUnavailableError(
                installationId,
                `GitHub would not issue an access token for installation ${installationId}.`,
            );
        };
        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "getInstallationToken" || prop === "listInstallationRepos") return unavailable;
                return Reflect.get(target, prop, receiver);
            },
        });
    }

    /** Installation ids whose uninstall GitHub rejects, so a test can cover the half-failed path. */
    readonly failDeleteInstallation: Set<number> = new Set();

    async deleteInstallation(installationId: number): Promise<void> {
        if (this.failDeleteInstallation.has(installationId)) {
            throw new Error(`GitHub refused to delete installation ${installationId}.`);
        }
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
