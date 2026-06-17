import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { GitHubApp, GitHubInstallationClient, GitTree, Repository } from "@autonoma/github";
import type { RepoIntrospection, SuggestedApp } from "@autonoma/types";
import { Service } from "../routes/service";

const TREE_CACHE_TTL_MS = 5 * 60 * 1000;
const TREE_CACHE_MAX_ENTRIES = 100;
/** Bound on per-introspection GitHub content calls (root manifests + candidate package.jsons). */
const MAX_CANDIDATE_DIRS = 12;
const CONVENTIONAL_APP_PARENTS = ["apps", "packages", "services"];
const K8S_NAME_MAX_LENGTH = 40;

interface CachedTree {
    tree: GitTree;
    expiresAt: number;
}

// Module-level so every service instance shares it; keyed by repo id + head SHA,
// so a push naturally invalidates the entry.
const treeCache = new Map<string, CachedTree>();

interface RepoContext {
    client: GitHubInstallationClient;
    repo: Repository;
    headSha: string;
}

/**
 * Read-only repository introspection for the PreviewKit topology builder: lists
 * the repo's file tree, detects workspace layout and Dockerfiles, and proposes
 * deployable apps the user can accept or edit. Detection is deliberately
 * conservative - suggestions are hints, never facts, and any GitHub failure
 * degrades to `status: "unavailable"` so manual setup is always possible.
 */
export class RepoIntrospectionService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly githubApp: GitHubApp,
    ) {
        super();
    }

    async introspect(
        organizationId: string,
        applicationId: string,
        githubRepositoryId?: number,
    ): Promise<RepoIntrospection> {
        this.logger.info("Introspecting repository", { organizationId, applicationId, githubRepositoryId });

        let context: RepoContext;
        try {
            context = await this.resolveRepoContext(organizationId, applicationId, githubRepositoryId);
        } catch (err) {
            this.logger.warn("Repository introspection unavailable", { organizationId, applicationId, err });
            return unavailable(err instanceof Error ? err.message : "GitHub is unavailable");
        }

        try {
            const tree = await this.getCachedTree(context);
            const dockerfiles = tree.paths.filter(isDockerfilePath).sort();
            const repoInfo = {
                githubRepositoryId: context.repo.id,
                fullName: context.repo.fullName,
                defaultBranch: context.repo.defaultBranch,
                headSha: context.headSha,
            };

            if (tree.truncated) {
                // Degrade to root-level detection only: the tree is incomplete, so
                // directory-based candidates would be arbitrary.
                const rootApp = await this.suggestRootApp(context, tree);
                return {
                    status: "ok",
                    repo: repoInfo,
                    apps: rootApp != null ? [rootApp] : [],
                    dockerfiles,
                };
            }

            const monorepoTool = await this.detectMonorepoTool(context, tree);
            const candidateDirs = await this.collectCandidateDirs(context, tree);
            const apps: SuggestedApp[] = [];

            for (const dir of candidateDirs.slice(0, MAX_CANDIDATE_DIRS)) {
                const suggestion = await this.suggestAppForDir(context, tree, dir, monorepoTool);
                if (suggestion != null) apps.push(suggestion);
            }

            if (apps.length === 0) {
                const rootApp = await this.suggestRootApp(context, tree);
                if (rootApp != null) apps.push(rootApp);
            }

            this.logger.info("Repository introspection complete", {
                applicationId,
                fullName: context.repo.fullName,
                appCount: apps.length,
                dockerfileCount: dockerfiles.length,
                monorepoTool,
            });

            const result: RepoIntrospection = { status: "ok", repo: repoInfo, apps, dockerfiles };
            if (monorepoTool != null) result.monorepoTool = monorepoTool;
            return result;
        } catch (err) {
            this.logger.warn("Repository introspection failed", {
                organizationId,
                applicationId,
                fullName: context.repo.fullName,
                err,
            });
            return unavailable(err instanceof Error ? err.message : "Failed to read repository contents");
        }
    }

    /**
     * The repo's file tree at its default-branch head, for config preflight checks.
     * Returns undefined when GitHub is unavailable - preflight must never block.
     */
    async getRepoTree(
        organizationId: string,
        applicationId: string,
        githubRepositoryId?: number,
    ): Promise<GitTree | undefined> {
        try {
            const context = await this.resolveRepoContext(organizationId, applicationId, githubRepositoryId);
            return await this.getCachedTree(context);
        } catch (err) {
            this.logger.warn("Repo tree unavailable", { organizationId, applicationId, githubRepositoryId, err });
            return undefined;
        }
    }

    private async resolveRepoContext(
        organizationId: string,
        applicationId: string,
        githubRepositoryId?: number,
    ): Promise<RepoContext> {
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

    private async getCachedTree(context: RepoContext): Promise<GitTree> {
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

    private async detectMonorepoTool(context: RepoContext, tree: GitTree): Promise<RepoIntrospection["monorepoTool"]> {
        const files = new Set(tree.paths);
        if (files.has("turbo.json")) return "turbo";
        if (files.has("pnpm-workspace.yaml")) return "pnpm-workspace";

        if (files.has("package.json")) {
            const rootPackage = await this.readPackageJson(context, "package.json");
            if (rootPackage?.workspaces != null) return "npm-workspace";
        }
        return undefined;
    }

    /**
     * Candidate app directories: workspace globs plus conventional `apps/*`,
     * `packages/*`, `services/*` directories that contain a `package.json` or a
     * `Dockerfile`. Ordered with workspace-derived candidates first.
     */
    private async collectCandidateDirs(context: RepoContext, tree: GitTree): Promise<string[]> {
        const files = new Set(tree.paths);
        const candidates: string[] = [];
        const seen = new Set<string>();
        const add = (dir: string) => {
            if (seen.has(dir)) return;
            if (!files.has(`${dir}/package.json`) && !files.has(`${dir}/Dockerfile`)) return;
            seen.add(dir);
            candidates.push(dir);
        };

        for (const glob of await this.collectWorkspaceGlobs(context, files)) {
            for (const dir of expandDirGlob(glob, tree.paths)) add(dir);
        }

        for (const parent of CONVENTIONAL_APP_PARENTS) {
            for (const dir of expandDirGlob(`${parent}/*`, tree.paths)) add(dir);
        }

        return candidates;
    }

    private async collectWorkspaceGlobs(context: RepoContext, files: Set<string>): Promise<string[]> {
        const globs: string[] = [];

        if (files.has("pnpm-workspace.yaml")) {
            const raw = await context.client.getFileContent(context.repo.id, "pnpm-workspace.yaml", context.headSha);
            if (raw != null) globs.push(...parsePnpmWorkspaceGlobs(raw));
        }

        if (files.has("package.json")) {
            const rootPackage = await this.readPackageJson(context, "package.json");
            const workspaces = rootPackage?.workspaces;
            if (Array.isArray(workspaces)) {
                globs.push(...workspaces.filter((entry): entry is string => typeof entry === "string"));
            }
        }

        return globs;
    }

    private async suggestAppForDir(
        context: RepoContext,
        tree: GitTree,
        dir: string,
        monorepoTool: RepoIntrospection["monorepoTool"],
    ): Promise<SuggestedApp | undefined> {
        const files = new Set(tree.paths);
        const evidence: string[] = [];
        const dockerfilePath = files.has(`${dir}/Dockerfile`) ? "Dockerfile" : undefined;
        if (dockerfilePath != null) evidence.push(`Dockerfile at ${dir}/Dockerfile`);

        const packageJson = files.has(`${dir}/package.json`)
            ? await this.readPackageJson(context, `${dir}/package.json`)
            : undefined;
        if (packageJson == null && dockerfilePath == null) return undefined;

        const scripts = packageJson?.scripts ?? {};
        const startScript = scripts["start"] ?? scripts["dev"];
        if (startScript != null) evidence.push(`package script: ${startScript}`);

        const portFromScripts = detectPortFromScripts(scripts);
        const framework = detectFramework(packageJson);
        if (framework != null) evidence.push(`detected ${framework.name}`);

        const port = portFromScripts ?? framework?.defaultPort;
        const confidence: SuggestedApp["confidence"] =
            dockerfilePath != null || portFromScripts != null ? "high" : packageJson != null ? "medium" : "low";

        const suggestion: SuggestedApp = {
            name: sanitizeK8sName(packageNameOrDir(packageJson, dir)),
            path: dir,
            confidence,
            evidence,
        };
        if (dockerfilePath != null) suggestion.dockerfile = dockerfilePath;
        if (monorepoTool === "turbo" && dockerfilePath == null && packageJson != null) suggestion.monorepo = "turbo";
        if (port != null) suggestion.port = port;
        return suggestion;
    }

    /** Root-of-repo fallback when no directory candidates were found (single-app repos). */
    private async suggestRootApp(context: RepoContext, tree: GitTree): Promise<SuggestedApp | undefined> {
        const files = new Set(tree.paths);
        const hasRootDockerfile = files.has("Dockerfile");
        const packageJson = files.has("package.json") ? await this.readPackageJson(context, "package.json") : undefined;
        if (!hasRootDockerfile && packageJson == null) return undefined;

        const evidence: string[] = [];
        if (hasRootDockerfile) evidence.push("Dockerfile at repo root");
        const scripts = packageJson?.scripts ?? {};
        const startScript = scripts["start"] ?? scripts["dev"];
        if (startScript == null && !hasRootDockerfile) return undefined;
        if (startScript != null) evidence.push(`package script: ${startScript}`);

        const portFromScripts = detectPortFromScripts(scripts);
        const framework = detectFramework(packageJson);
        if (framework != null) evidence.push(`detected ${framework.name}`);
        const port = portFromScripts ?? framework?.defaultPort;

        const suggestion: SuggestedApp = {
            name: sanitizeK8sName(packageNameOrDir(packageJson, context.repo.name)),
            path: ".",
            confidence: hasRootDockerfile || portFromScripts != null ? "high" : "medium",
            evidence,
        };
        if (hasRootDockerfile) suggestion.dockerfile = "Dockerfile";
        if (port != null) suggestion.port = port;
        return suggestion;
    }

    private async readPackageJson(context: RepoContext, path: string): Promise<ParsedPackageJson | undefined> {
        const raw = await context.client.getFileContent(context.repo.id, path, context.headSha);
        if (raw == null) return undefined;
        try {
            return parsePackageJson(raw);
        } catch (err) {
            this.logger.debug("Failed to parse package.json during introspection", {
                fullName: context.repo.fullName,
                path,
                err,
            });
            return undefined;
        }
    }
}

interface ParsedPackageJson {
    name?: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    workspaces?: unknown;
}

function parsePackageJson(raw: string): ParsedPackageJson {
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

function unavailable(reason: string): RepoIntrospection {
    return { status: "unavailable", reason, apps: [], dockerfiles: [] };
}

function isDockerfilePath(path: string): boolean {
    const basename = path.split("/").at(-1) ?? "";
    return basename === "Dockerfile" || basename.startsWith("Dockerfile.");
}

/**
 * Expands a single-level directory glob (`apps/*`) against the file tree,
 * returning matched directories. Only trailing `/*` (or `/**`) globs are
 * supported - anything more exotic is skipped rather than guessed at.
 */
function expandDirGlob(glob: string, paths: string[]): string[] {
    const normalized = glob.replace(/\/\*\*?$/, "");
    if (normalized.includes("*")) return [];
    if (normalized === glob) {
        // Not a glob at all - a literal directory entry.
        return paths.some((path) => path.startsWith(`${normalized}/`)) ? [normalized] : [];
    }

    const prefix = `${normalized}/`;
    const dirs = new Set<string>();
    for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const firstSegment = rest.split("/")[0];
        if (firstSegment != null && rest.includes("/")) dirs.add(`${normalized}/${firstSegment}`);
    }
    return [...dirs].sort();
}

/** Conservative line-based parse of pnpm-workspace.yaml `packages:` entries (avoids a YAML dependency). */
function parsePnpmWorkspaceGlobs(raw: string): string[] {
    const globs: string[] = [];
    let inPackages = false;
    for (const line of raw.split("\n")) {
        if (/^packages\s*:/.test(line)) {
            inPackages = true;
            continue;
        }
        if (inPackages) {
            const match = /^\s+-\s*["']?([^"'#\s]+)["']?/.exec(line);
            if (match?.[1] != null) {
                if (!match[1].startsWith("!")) globs.push(match[1]);
                continue;
            }
            if (/^\S/.test(line)) inPackages = false;
        }
    }
    return globs;
}

const PORT_PATTERNS = [/(?:^|\s)-p\s+(\d{2,5})/, /--port[=\s](\d{2,5})/, /\bPORT=(\d{2,5})/];

function detectPortFromScripts(scripts: Record<string, string>): number | undefined {
    for (const scriptName of ["start", "dev", "serve", "preview"]) {
        const script = scripts[scriptName];
        if (script == null) continue;
        for (const pattern of PORT_PATTERNS) {
            const match = pattern.exec(script);
            if (match?.[1] != null) return Number(match[1]);
        }
    }
    return undefined;
}

const FRAMEWORKS: Array<{ name: string; dependency: string; defaultPort: number }> = [
    { name: "Next.js", dependency: "next", defaultPort: 3000 },
    { name: "Vite", dependency: "vite", defaultPort: 5173 },
    { name: "Remix", dependency: "@remix-run/node", defaultPort: 3000 },
    { name: "Express", dependency: "express", defaultPort: 3000 },
    { name: "Fastify", dependency: "fastify", defaultPort: 3000 },
    { name: "Hono", dependency: "hono", defaultPort: 3000 },
];

function detectFramework(
    packageJson: ParsedPackageJson | undefined,
): { name: string; defaultPort: number } | undefined {
    if (packageJson == null) return undefined;
    for (const framework of FRAMEWORKS) {
        if (
            packageJson.dependencies[framework.dependency] != null ||
            packageJson.devDependencies[framework.dependency] != null
        ) {
            return { name: framework.name, defaultPort: framework.defaultPort };
        }
    }
    return undefined;
}

function packageNameOrDir(packageJson: ParsedPackageJson | undefined, dir: string): string {
    const packageName = packageJson?.name;
    if (packageName != null && packageName !== "") {
        // Strip a scope like "@acme/web" -> "web".
        return packageName.split("/").at(-1) ?? packageName;
    }
    return dir.split("/").at(-1) ?? dir;
}

function sanitizeK8sName(value: string): string {
    const sanitized = value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, K8S_NAME_MAX_LENGTH)
        .replace(/-+$/g, "");
    return sanitized === "" ? "app" : sanitized;
}
