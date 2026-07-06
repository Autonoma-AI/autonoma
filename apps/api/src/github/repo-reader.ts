import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { GitHubApp, GitHubInstallationClient, GitTree, Repository } from "@autonoma/github";
import { Service } from "../routes/service";

const TREE_CACHE_TTL_MS = 5 * 60 * 1000;
const TREE_CACHE_MAX_ENTRIES = 100;

interface CachedTree {
    tree: GitTree;
    expiresAt: number;
}

const treeCache = new Map<string, CachedTree>();

/** A resolved GitHub repository at a specific head, ready for content reads. */
export interface RepoContext {
    client: GitHubInstallationClient;
    repo: Repository;
    headSha: string;
}

/** The subset of a repo's `package.json` the PreviewKit heuristics care about. */
export interface ParsedPackageJson {
    name?: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    workspaces?: unknown;
}

export class RepoReader extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly githubApp: GitHubApp,
    ) {
        super();
    }

    async resolveRepoContext(
        organizationId: string,
        applicationId: string,
        githubRepositoryId?: number,
    ): Promise<RepoContext> {
        this.logger.info("Resolving repo context", { organizationId, applicationId, githubRepositoryId });
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const repoId = githubRepositoryId ?? application.githubRepositoryId ?? undefined;
        if (repoId == null) throw new NotFoundError("Application is not linked to a GitHub repository");

        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId },
            select: { installationId: true },
        });
        if (installation == null) throw new NotFoundError("No GitHub installation found");

        const client = await this.githubApp.getInstallationClient(installation.installationId);
        const repo = await client.getRepository(repoId);
        const headSha = await client.getBranchHead(repoId, repo.defaultBranch);

        return { client, repo, headSha };
    }

    async getCachedTree(context: RepoContext): Promise<GitTree> {
        const key = `${context.repo.id}:${context.headSha}`;
        const cached = treeCache.get(key);
        if (cached != null && cached.expiresAt > Date.now()) return cached.tree;

        const tree = await context.client.getGitTree(context.repo.id, context.headSha);

        if (treeCache.size >= TREE_CACHE_MAX_ENTRIES) {
            const oldestKey = treeCache.keys().next().value;
            if (oldestKey != null) treeCache.delete(oldestKey);
        }
        treeCache.set(key, { tree, expiresAt: Date.now() + TREE_CACHE_TTL_MS });

        return tree;
    }

    /** Raw file content at the resolved head, or undefined when the file is absent. */
    async getFileContent(context: RepoContext, path: string): Promise<string | undefined> {
        return await context.client.getFileContent(context.repo.id, path, context.headSha);
    }

    /** Reads and parses a `package.json`; returns undefined when absent or unparseable. */
    async readPackageJson(context: RepoContext, path: string): Promise<ParsedPackageJson | undefined> {
        const raw = await this.getFileContent(context, path);
        if (raw == null) return undefined;
        try {
            return parsePackageJson(raw);
        } catch (err) {
            this.logger.warn("Failed to parse package.json", { fullName: context.repo.fullName, path, err });
            return undefined;
        }
    }
}

export function parsePackageJson(raw: string): ParsedPackageJson {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null) throw new Error("package.json is not an object");

    const result: ParsedPackageJson = { scripts: {}, dependencies: {}, devDependencies: {} };
    if ("name" in parsed && typeof parsed.name === "string") result.name = parsed.name;
    if ("workspaces" in parsed) result.workspaces = parsed.workspaces;
    for (const field of ["scripts", "dependencies", "devDependencies"] as const) {
        if (!(field in parsed)) continue;
        const value: unknown = Reflect.get(parsed, field);
        if (typeof value !== "object" || value == null) continue;
        for (const [key, entry] of Object.entries(value)) {
            if (typeof entry === "string") result[field][key] = entry;
        }
    }
    return result;
}
