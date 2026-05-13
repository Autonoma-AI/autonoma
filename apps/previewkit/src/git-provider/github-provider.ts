import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { App } from "@octokit/app";
import { extract as extractTar } from "tar-fs";
import { logger } from "../logger";
import type { GitProvider } from "./git-provider";

function parseRepo(repoFullName: string): { owner: string; repo: string } {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) throw new Error(`Invalid repo name: ${repoFullName}`);
    return { owner, repo };
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

        // The tarball endpoint returns the gzipped archive body as ArrayBuffer.
        const response = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
            owner,
            repo,
            ref,
        });

        // Octokit returns the binary body as an ArrayBuffer for this endpoint.
        const buffer = Buffer.from(response.data as ArrayBuffer);

        // GitHub wraps every tarball in a single top-level directory like
        // `owner-repo-<short-sha>/`. Strip it so files land directly under `targetDir`.
        const extractor = extractTar(targetDir, {
            map: (header) => {
                const firstSlash = header.name.indexOf("/");
                if (firstSlash >= 0) {
                    header.name = header.name.slice(firstSlash + 1);
                }
                return header;
            },
        });

        await pipeline(Readable.from(buffer), createGunzip(), extractor);

        logger.info("Repo tarball extracted", { repoFullName, ref, targetDir, bytes: buffer.length });
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
}
