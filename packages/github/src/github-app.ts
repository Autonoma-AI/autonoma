import { logger } from "@autonoma/logger";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { EtagStore } from "./etag-store";
import type { GitHubInstallationClient } from "./github-installation-client";
import { OctokitGitHubInstallationClient } from "./github-installation-client";

const appLogger = logger.child({ name: "OctokitGitHubApp" });

// Octokit composed with GitHub's recommended throttling + retry plugins. The throttling
// plugin serializes requests and honors Retry-After / x-ratelimit-* headers; the retry
// plugin backs off transient failures. Applied to every installation client, so all
// platform-wide GitHub calls are rate-limit-safe.
const ThrottledOctokit = Octokit.plugin(throttling, retry).defaults({
    throttle: {
        onRateLimit: (
            retryAfter: number,
            options: { method?: string; url?: string },
            _octokit: unknown,
            retryCount: number,
        ): boolean => {
            appLogger.warn("GitHub primary rate limit hit", {
                extra: { method: options.method, url: options.url, retryAfter, retryCount },
            });
            // Retry once after waiting; give up after that to avoid unbounded stalls.
            return retryCount < 1;
        },
        onSecondaryRateLimit: (retryAfter: number, options: { method?: string; url?: string }): void => {
            appLogger.warn("GitHub secondary rate limit hit; not retrying", {
                extra: { method: options.method, url: options.url, retryAfter },
            });
        },
    },
});

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

    constructor(
        credentials: GitHubAppCredentials,
        private readonly etagStore?: EtagStore,
    ) {
        this.slug = credentials.appSlug;
        this.app = new App({
            appId: credentials.appId,
            privateKey: credentials.privateKey,
            webhooks: { secret: credentials.webhookSecret },
            Octokit: ThrottledOctokit,
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
        const octokit = await this.app.getInstallationOctokit(installationId).catch((err: unknown) => {
            throw installationUnavailable(installationId, this.slug, err);
        });
        return new OctokitGitHubInstallationClient(octokit, installationId, this.etagStore);
    }

    /**
     * Uninstalls the app from the account, on GitHub.
     *
     * Authenticated as the APP (JWT), not as the installation. GitHub is explicit that
     * `DELETE /app/installations/{installation_id}` requires a JWT - an installation access token
     * is rejected - so the previous version, which used the installation client, never actually
     * uninstalled anything. Its caller swallowed the failure and cleared our own row regardless,
     * which is why disconnecting appeared to do nothing: Autonoma forgot the installation while
     * GitHub still had the app installed.
     *
     * `this.app.octokit` is the app-level client and carries the JWT.
     */
    async deleteInstallation(installationId: number): Promise<void> {
        await this.app.octokit.request("DELETE /app/installations/{installation_id}", {
            installation_id: installationId,
        });
    }

    async verifyWebhook(body: string, signature: string): Promise<boolean> {
        return this.app.webhooks.verify(body, signature);
    }
}

/**
 * Thrown when GitHub refuses to mint an access token for an installation we still
 * have on record. Its own message is a bare "Not Found" plus a link to the REST
 * reference for the token endpoint, which reads as an Autonoma bug to everyone
 * who sees it - including a coding agent driving the MCP, which is where it
 * surfaces most. This one names the cause and the single thing that fixes it.
 */
export class GitHubInstallationUnavailableError extends Error {
    constructor(
        readonly installationId: number,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = "GitHubInstallationUnavailableError";
    }
}

function installationUnavailable(installationId: number, appSlug: string, cause: unknown): Error {
    appLogger.warn("Could not mint an installation token; the GitHub App installation is gone or suspended", {
        extra: { installationId, cause: cause instanceof Error ? cause.message : String(cause) },
    });
    return new GitHubInstallationUnavailableError(
        installationId,
        `GitHub would not issue an access token for the Autonoma GitHub App installation (id ${installationId}) on ` +
            `this organization, so Autonoma currently cannot read anything from its repositories. The installation ` +
            `was almost certainly removed, suspended, or had its repository access revoked on GitHub. Reinstall the ` +
            `"${appSlug}" GitHub App for this organization (or re-grant it access to the repository) at ` +
            `https://github.com/settings/installations, then retry. Nothing on the Autonoma side needs changing.`,
        { cause },
    );
}
