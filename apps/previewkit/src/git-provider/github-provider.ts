import { Readable } from "node:stream";
import { App } from "@octokit/app";
import { logger } from "../logger";
import { extractTarballStream } from "./extract-tarball-stream";
import type { GitProvider, GitRepository } from "./git-provider";

function parseRepo(repoFullName: string): { owner: string; repo: string } {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) throw new Error(`Invalid repo name: ${repoFullName}`);
    return { owner, repo };
}

function isNotFoundError(error: unknown): boolean {
    return typeof error === "object" && error != null && "status" in error && error.status === 404;
}

/**
 * Narrows octokit's `response.data` into a Node Readable for streaming. With
 * `parseSuccessResponseBody:false`, octokit sets `data` to the fetch response's
 * body - a web ReadableStream - though its static type still reflects the
 * endpoint's parsed shape. A guard at this boundary keeps us honest without an
 * `as` cast: if octokit ever changes the shape, this throws loudly instead of
 * mis-streaming.
 */
function toNodeStream(data: unknown): Readable {
    if (!(data instanceof ReadableStream)) {
        throw new Error("Expected a streaming response body (ReadableStream) from the GitHub tarball endpoint");
    }
    return Readable.from(readWebStream(data));
}

/**
 * Bridges a web ReadableStream to an async iterable of chunks via its reader.
 * Going through the stream's own `getReader()` keeps us on a single
 * ReadableStream type, sidestepping the DOM-vs-`node:stream/web` mismatch that
 * `Readable.fromWeb` trips over under strict TS.
 */
async function* readWebStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value != null) yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

interface GitHubProviderOptions {
    appId: string;
    privateKey: string;
}

export class GitHubProvider implements GitProvider {
    readonly name = "github";
    private app: App;

    constructor(options: GitHubProviderOptions) {
        this.app = new App({
            appId: options.appId,
            privateKey: options.privateKey,
        });
    }

    private async getInstallationOctokit(repoFullName: string) {
        const { owner, repo } = parseRepo(repoFullName);
        const { data: installation } = await this.app.octokit.request("GET /repos/{owner}/{repo}/installation", {
            owner,
            repo,
        });
        return this.app.getInstallationOctokit(installation.id);
    }

    private getInstallationOctokitById(installationId: number) {
        return this.app.getInstallationOctokit(installationId);
    }

    async getRepository(installationId: number, repositoryId: number): Promise<GitRepository> {
        const octokit = await this.getInstallationOctokitById(installationId);
        const { data } = await octokit.request("GET /repositories/{repository_id}", {
            repository_id: repositoryId,
        });

        return {
            id: data.id,
            name: data.name,
            fullName: data.full_name,
            defaultBranch: data.default_branch,
            private: data.private,
        };
    }

    async getRepositoryByFullName(repoFullName: string): Promise<GitRepository | undefined> {
        const { owner, repo } = parseRepo(repoFullName);

        try {
            const octokit = await this.getInstallationOctokit(repoFullName);
            const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });

            return {
                id: data.id,
                name: data.name,
                fullName: data.full_name,
                defaultBranch: data.default_branch,
                private: data.private,
            };
        } catch (error: unknown) {
            if (isNotFoundError(error)) {
                logger.info("Repository not found by full name", { repoFullName });
                return undefined;
            }
            throw error;
        }
    }

    async getBranchHead(repoFullName: string, branchName: string): Promise<string> {
        const { owner, repo } = parseRepo(repoFullName);
        const octokit = await this.getInstallationOctokit(repoFullName);
        const { data } = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
            owner,
            repo,
            branch: branchName,
        });

        return data.commit.sha;
    }

    async fetchFileContent(repoFullName: string, path: string, ref: string): Promise<string | undefined> {
        const { owner, repo } = parseRepo(repoFullName);
        const octokit = await this.getInstallationOctokit(repoFullName);

        try {
            const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
                owner,
                repo,
                path,
                ref,
            });

            if (Array.isArray(data) || data.type !== "file") {
                return undefined;
            }

            return Buffer.from(data.content, "base64").toString("utf-8");
        } catch (error: unknown) {
            if (error instanceof Error && "status" in error && (error as { status: number }).status === 404) {
                return undefined;
            }
            throw error;
        }
    }

    async fetchRepoTarball(repoFullName: string, ref: string, targetDir: string): Promise<void> {
        const { owner, repo } = parseRepo(repoFullName);
        const octokit = await this.getInstallationOctokit(repoFullName);

        logger.info("Downloading repo tarball", { repoFullName, ref });

        // parseSuccessResponseBody:false tells octokit not to buffer the body,
        // so `response.data` is the response's ReadableStream and we can stream
        // its gzip straight through gunzip + tar extraction instead of holding
        // the whole archive in memory (see extractTarballStream for why that matters).
        const response = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
            owner,
            repo,
            ref,
            request: { parseSuccessResponseBody: false },
        });

        await extractTarballStream(toNodeStream(response.data), targetDir);

        logger.info("Repo tarball extracted", { repoFullName, ref, targetDir });
    }

    async postComment(repoFullName: string, prNumber: number, body: string): Promise<string> {
        const { owner, repo } = parseRepo(repoFullName);
        const octokit = await this.getInstallationOctokit(repoFullName);

        const { data } = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
            owner,
            repo,
            issue_number: prNumber,
            body,
        });

        logger.info("Posted PR comment", { commentId: data.id, repoFullName, prNumber });

        return String(data.id);
    }

    async updateComment(repoFullName: string, commentId: string, body: string): Promise<void> {
        const { owner, repo } = parseRepo(repoFullName);
        const octokit = await this.getInstallationOctokit(repoFullName);

        await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
            owner,
            repo,
            comment_id: Number(commentId),
            body,
        });
    }

    async setCommitStatus(
        repoFullName: string,
        sha: string,
        state: "pending" | "success" | "failure" | "error",
        description: string,
        targetUrl?: string,
    ): Promise<void> {
        const { owner, repo } = parseRepo(repoFullName);
        const octokit = await this.getInstallationOctokit(repoFullName);

        await octokit.request("POST /repos/{owner}/{repo}/statuses/{sha}", {
            owner,
            repo,
            sha,
            state,
            description,
            target_url: targetUrl,
            context: "previewkit",
        });

        logger.info("Set commit status", { repoFullName, sha, state });
    }

    async createDeployment(
        repoFullName: string,
        ref: string,
        environment: string,
        payload: Record<string, string>,
    ): Promise<number> {
        const { owner, repo } = parseRepo(repoFullName);
        const octokit = await this.getInstallationOctokit(repoFullName);

        logger.info("Creating GitHub deployment", { repoFullName, environment, payload });

        const { data } = await octokit.request("POST /repos/{owner}/{repo}/deployments", {
            owner,
            repo,
            ref,
            environment,
            auto_merge: false,
            required_contexts: [],
            transient_environment: true,
            payload: payload as Record<string, unknown>,
        });

        if (!("id" in data)) {
            throw new Error(`GitHub deployment blocked: ${data.message ?? "unknown reason"}`);
        }

        logger.info("Created GitHub deployment", { repoFullName, deploymentId: data.id, environment });

        return data.id;
    }

    async createDeploymentStatus(
        repoFullName: string,
        deploymentId: number,
        state: "success" | "failure" | "in_progress" | "error",
        targetUrl?: string,
        description?: string,
    ): Promise<void> {
        const { owner, repo } = parseRepo(repoFullName);
        const octokit = await this.getInstallationOctokit(repoFullName);

        await octokit.request("POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses", {
            owner,
            repo,
            deployment_id: deploymentId,
            state,
            target_url: targetUrl,
            environment_url: targetUrl,
            description,
        });

        logger.info("Created GitHub deployment status", { repoFullName, deploymentId, state });
    }
}
