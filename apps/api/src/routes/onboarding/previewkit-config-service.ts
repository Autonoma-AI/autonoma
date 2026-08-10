import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import {
    authoringPreviewConfigSchema,
    isSameRepository,
    previewConfigSchema,
    topologyRepositories,
    validatePreviewConfigSemantics,
    zodIssuesToConfigIssues,
    type ConfigIssue,
    type PreviewConfig,
} from "@autonoma/types";
import { z } from "zod";
import { applicationBranchRefs } from "../../github/application-branch-refs";
import type { OnboardingGithubRepository, OnboardingManagerOptions } from "./onboarding-dependencies";
import {
    defaultPreviewkitConfig,
    filterDockerfilePaths,
    kebabCaseAppName,
    normalizeRepoPath,
    parseConfigShapeOrThrow,
    upsertConfig,
} from "./previewkit-config-helpers";

/** One repository of the preview topology, as the config editor sees it. */
export interface OnboardingPreviewkitRepo {
    /** Repo full name (`owner/repo`). */
    repo: string;
    /** Whether this is the Application's own repository. */
    primary: boolean;
    /** GitHub-side id, when the installation listing resolved it (drives repo introspection). */
    githubRepositoryId?: number;
}

export interface OnboardingPreviewkitConfig {
    applicationId: string;
    saved: boolean;
    document: PreviewConfig;
    /**
     * The branch the base preview (environment 0) deploys from - the app's stored
     * deploy ref. Defaults to the repo's default branch (set when the repo is
     * linked); the user or a coding agent can override it. Only populated by
     * {@link PreviewkitConfigService.getConfig} (the read path).
     */
    deployBranch?: string;
    /**
     * Every repository of the topology (derived from `apps[].repository`, the
     * Application's own repo always included), each resolved against the GitHub
     * installation when possible.
     */
    repos: OnboardingPreviewkitRepo[];
    /**
     * Warning-severity semantic issues on the saved topology. Only set by
     * `save`: errors block the save, but warnings would otherwise vanish silently -
     * and the MCP agent path has no other channel to hear about them (e.g. a
     * database service no app connection references).
     */
    warnings?: ConfigIssue[];
}

export interface PreviewkitConfigValidationResult {
    /** True when no `error`-severity issue was found. Warnings never flip this. */
    valid: boolean;
    issues: ConfigIssue[];
}

interface ApplicationRepoContext {
    id: string;
    name: string;
    githubRepositoryId: number | null;
}

/**
 * Owns the PreviewKit config domain for onboarding: loading the active config,
 * saving it (latest-only; the single document carries the whole topology, every
 * app tagged with its `repository`), and validating documents. The caller
 * ({@link OnboardingManager}) is responsible for the onboarding-state guards
 * (repo linked, step reached) before delegating.
 */
export class PreviewkitConfigService {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly options: OnboardingManagerOptions,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /**
     * The target repo's Dockerfiles at its default-branch head, for the config
     * editor's Dockerfile picker. Filters the file tree server-side so only the
     * pickable paths cross the wire. `truncated` is passed through: when the tree
     * was too large to list in full the Dockerfile set may be incomplete, so the
     * client falls back to a free-text path. Degrades to `undefined` when GitHub
     * introspection is unavailable (unconfigured, or a live GitHub failure).
     */
    async listDockerfiles(
        applicationId: string,
        organizationId: string,
        githubRepositoryId?: number,
    ): Promise<{ paths: string[]; truncated: boolean } | undefined> {
        this.logger.info("Listing repo Dockerfiles for PreviewKit config editor", {
            applicationId,
            organizationId,
            githubRepositoryId,
        });
        const introspection = this.options.repoIntrospection;
        if (introspection == null) return undefined;
        const tree = await introspection.getRepoTree(organizationId, applicationId, githubRepositoryId);
        if (tree == null) return undefined;
        return { paths: filterDockerfilePaths(tree.paths), truncated: tree.truncated };
    }

    async getConfig(applicationId: string, organizationId: string): Promise<OnboardingPreviewkitConfig> {
        this.logger.info("Loading onboarding PreviewKit config", { applicationId, organizationId });
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                id: true,
                name: true,
                githubRepositoryId: true,
                previewDeployRef: true,
                mainBranch: { select: { name: true } },
                previewkitConfig: { select: { document: true } },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const deployBranch = applicationBranchRefs(application).deploy;
        const installationRepos = await this.resolveInstallationRepos(organizationId);
        // The read path keeps working with a display-only placeholder so the
        // editor loads even when GitHub is briefly unreachable; save() refuses it.
        const primaryRepo =
            (await this.resolvePrimaryRepository(application, installationRepos)) ??
            this.placeholderRepository(application);

        const stored = application.previewkitConfig;
        if (stored == null) {
            const document = defaultPreviewkitConfig(application.name, primaryRepo);
            return {
                applicationId,
                saved: false,
                document,
                deployBranch,
                repos: this.buildRepoList(document, primaryRepo, installationRepos),
            };
        }

        const validation = previewConfigSchema.safeParse(stored.document);
        if (!validation.success) {
            throw new ConflictError(`Saved PreviewKit config is invalid: ${z.prettifyError(validation.error)}`);
        }

        return {
            applicationId,
            saved: true,
            document: validation.data,
            deployBranch,
            repos: this.buildRepoList(validation.data, primaryRepo, installationRepos),
        };
    }

    async save(applicationId: string, organizationId: string, document: unknown): Promise<OnboardingPreviewkitConfig> {
        this.logger.info("Saving onboarding PreviewKit config", { applicationId, organizationId });

        const config = parseConfigShapeOrThrow(document);
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true, name: true, githubRepositoryId: true },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const installationRepos = await this.resolveInstallationRepos(organizationId);
        const primaryRepo = await this.resolvePrimaryRepository(application, installationRepos);
        // Never persist a config validated against a guess: an unresolvable
        // primary repo would bypass the coverage check, and the runner would
        // treat every app as a dependency of a repo that doesn't exist.
        if (primaryRepo == null) {
            throw new BadRequestError(
                "Could not resolve this application's repository (GitHub is unreachable and no preview has " +
                    "deployed yet) - retry once GitHub is available",
            );
        }

        // Semantic checks (depends_on, primary, hooks, repo membership) run on
        // the whole topology - the single document is exactly what deploys.
        const issues = [
            ...validatePreviewConfigSemantics(config),
            ...this.validateTopologyRepositories(config, primaryRepo, installationRepos),
        ];
        const blockingIssues = issues.filter((issue) => issue.severity === "error");
        if (blockingIssues.length > 0) {
            const issueText = blockingIssues
                .map((issue) => {
                    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
                    return `${path}${issue.message}`;
                })
                .join("; ");
            throw new BadRequestError(`Invalid PreviewKit config: ${issueText}`);
        }
        const warnings = issues.filter((issue) => issue.severity === "warning");
        if (warnings.length > 0) {
            this.logger.info("PreviewKit config saved with warnings", {
                applicationId,
                extra: { warnings: warnings.map((issue) => issue.message) },
            });
        }

        await upsertConfig(this.db, applicationId, config);

        return {
            applicationId,
            saved: true,
            document: config,
            repos: this.buildRepoList(config, primaryRepo, installationRepos),
            warnings,
        };
    }

    /**
     * Validates a PreviewKit config document and returns every finding as data
     * (never throws for findings - tRPC errors flatten to message strings, which
     * the dashboard cannot map back to form fields). Runs schema validation,
     * semantic checks, repository-membership checks against the Application's
     * repo, and - when GitHub access is available - per-repository preflight
     * checks against each repo's file tree.
     */
    async validate(
        applicationId: string,
        organizationId: string,
        document: unknown,
    ): Promise<PreviewkitConfigValidationResult> {
        this.logger.info("Validating onboarding PreviewKit config", { applicationId, organizationId });

        // The authoring contract, matching `parseConfigShapeOrThrow`: this backs the
        // editor's live validation, so it must report exactly what a save would
        // reject - including an app still on a retired framework preset.
        const parsed = authoringPreviewConfigSchema.safeParse(document);
        if (!parsed.success) {
            return { valid: false, issues: zodIssuesToConfigIssues(parsed.error) };
        }

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true, name: true, githubRepositoryId: true },
        });
        if (application == null) throw new NotFoundError("Application not found");
        const installationRepos = await this.resolveInstallationRepos(organizationId);
        const primaryRepo = await this.resolvePrimaryRepository(application, installationRepos);

        const issues = validatePreviewConfigSemantics(parsed.data);
        if (primaryRepo == null) {
            // Mirrors the save-time rejection so the editor's live validation
            // reports exactly what a save would refuse.
            issues.push({
                severity: "error",
                code: "primary_repository_unresolved",
                path: ["apps"],
                message:
                    "Could not resolve this application's repository (GitHub is unreachable and no preview has " +
                    "deployed yet) - the config cannot be saved until it resolves",
            });
        } else {
            issues.push(...this.validateTopologyRepositories(parsed.data, primaryRepo, installationRepos));
            issues.push(
                ...(await this.preflightPreviewkitConfig(
                    applicationId,
                    organizationId,
                    parsed.data,
                    primaryRepo,
                    installationRepos,
                )),
            );
        }

        return { valid: !issues.some((issue) => issue.severity === "error"), issues };
    }

    /**
     * Resolves the Application's repo full name (`owner/repo`). The Application
     * row stores only the numeric GitHub repo id, so the name comes from the
     * installation listing, falling back to the newest PreviewkitEnvironment the
     * repo ever deployed. Undefined when neither resolves (GitHub unavailable
     * AND the repo never deployed): the read path degrades to a display-only
     * placeholder, but saving is blocked - a persisted synthetic repository
     * would bypass primary-coverage validation and the runner would treat it as
     * a dependency and skip every app.
     */
    private async resolvePrimaryRepository(
        application: ApplicationRepoContext,
        installationRepos: Map<string, OnboardingGithubRepository> | undefined,
    ): Promise<string | undefined> {
        const { githubRepositoryId } = application;
        if (githubRepositoryId != null && installationRepos != null) {
            for (const repo of installationRepos.values()) {
                if (repo.id === githubRepositoryId) return repo.fullName;
            }
        }
        if (githubRepositoryId != null) {
            const environment = await this.db.previewkitEnvironment.findFirst({
                where: { githubRepositoryId },
                orderBy: { updatedAt: "desc" },
                select: { repoFullName: true },
            });
            if (environment != null) return environment.repoFullName;
        }
        this.logger.warn("Could not resolve the application's repo full name", {
            applicationId: application.id,
            extra: { githubRepositoryId },
        });
        return undefined;
    }

    /** Display-only stand-in when the primary repo cannot be resolved; never saveable. */
    private placeholderRepository(application: ApplicationRepoContext): string {
        return `unknown/${kebabCaseAppName(application.name)}`;
    }

    /**
     * The topology's repositories for the editor: every distinct
     * `apps[].repository` plus the Application's own repo (so a fresh config
     * knows what to prefill), each joined to the installation listing for its
     * GitHub id. Order: primary first, then by first appearance in the apps.
     */
    private buildRepoList(
        config: PreviewConfig,
        primaryRepo: string,
        installationRepos: Map<string, OnboardingGithubRepository> | undefined,
    ): OnboardingPreviewkitRepo[] {
        const repos: string[] = [primaryRepo];
        for (const repo of topologyRepositories(config)) {
            if (!repos.some((existing) => isSameRepository(existing, repo))) repos.push(repo);
        }
        return repos.map((repo) => {
            const githubRepositoryId = this.findInstallationRepo(installationRepos, repo)?.id;
            return {
                repo,
                primary: isSameRepository(repo, primaryRepo),
                githubRepositoryId,
            };
        });
    }

    /**
     * Repository-membership checks that need the Application context (and are
     * therefore not part of the pure `validatePreviewConfigSemantics`):
     * - error when no app builds from the Application's own repository - the
     *   PR's code would never deploy;
     * - warning per repository the GitHub installation cannot access (typo,
     *   rename, or the installation was never granted the repo) - the deploy
     *   would skip its apps.
     * The accessibility check degrades silently when GitHub is unavailable
     * (dev/self-host); an unresolvable primary repo is rejected before this runs.
     */
    private validateTopologyRepositories(
        config: PreviewConfig,
        primaryRepo: string,
        installationRepos: Map<string, OnboardingGithubRepository> | undefined,
    ): ConfigIssue[] {
        const issues: ConfigIssue[] = [];
        const repos = topologyRepositories(config);

        const referencesPrimary = [...repos].some((repo) => isSameRepository(repo, primaryRepo));
        if (!referencesPrimary) {
            issues.push({
                severity: "error",
                code: "primary_repository_not_referenced",
                path: ["apps"],
                message:
                    `No app builds from this application's repository "${primaryRepo}" - the PR's code would ` +
                    `never deploy. Set \`repository: "${primaryRepo}"\` on the app it builds.`,
            });
        }

        if (installationRepos != null) {
            config.apps.forEach((app, appIndex) => {
                if (this.findInstallationRepo(installationRepos, app.repository) != null) return;
                issues.push({
                    severity: "warning",
                    code: "repository_not_accessible",
                    path: ["apps", appIndex, "repository"],
                    message:
                        `Repository "${app.repository}" is not accessible to the GitHub installation - ` +
                        `its apps will be skipped at deploy time`,
                });
            });
        }

        return issues;
    }

    private findInstallationRepo(
        installationRepos: Map<string, OnboardingGithubRepository> | undefined,
        repo: string,
    ): OnboardingGithubRepository | undefined {
        if (installationRepos == null) return undefined;
        const exact = installationRepos.get(repo);
        if (exact != null) return exact;
        for (const candidate of installationRepos.values()) {
            if (isSameRepository(candidate.fullName, repo)) return candidate;
        }
        return undefined;
    }

    /** Lists the org installation's repos keyed by full name; undefined when GitHub is unavailable. */
    private async resolveInstallationRepos(
        organizationId: string,
    ): Promise<Map<string, OnboardingGithubRepository> | undefined> {
        const github = this.options.github;
        if (github == null) return undefined;
        try {
            const listing = await github.listRepositories(organizationId);
            if (listing.unavailable != null) {
                this.logger.warn("Installation repositories are unavailable", {
                    organizationId,
                    extra: { reason: listing.unavailable },
                });
                return undefined;
            }
            return new Map(listing.repos.map((repo) => [repo.fullName, repo]));
        } catch (err) {
            this.logger.warn("Failed to list installation repositories", { organizationId, err });
            return undefined;
        }
    }

    /**
     * Repo-aware preflight: checks that each app's `path` (and explicit
     * `dockerfile`) exists in its repository's file tree - every repo of the
     * topology is checked against its own tree. Findings are warnings, not
     * errors - the active branch may differ from what the user is about to
     * push. Skips repos whose tree is unavailable (GitHub introspection off,
     * repo not resolvable, or the tree was truncated).
     */
    private async preflightPreviewkitConfig(
        applicationId: string,
        organizationId: string,
        config: PreviewConfig,
        primaryRepo: string,
        installationRepos: Map<string, OnboardingGithubRepository> | undefined,
    ): Promise<ConfigIssue[]> {
        const introspection = this.options.repoIntrospection;
        if (introspection == null) return [];

        const issues: ConfigIssue[] = [];
        for (const repo of topologyRepositories(config)) {
            // The primary repo's tree resolves from the Application link even
            // without an installation listing; dependency repos need their id.
            const githubRepositoryId = this.findInstallationRepo(installationRepos, repo)?.id;
            if (!isSameRepository(repo, primaryRepo) && githubRepositoryId == null) continue;

            let tree: { paths: string[]; truncated: boolean } | undefined;
            try {
                tree = await introspection.getRepoTree(organizationId, applicationId, githubRepositoryId);
            } catch (err) {
                this.logger.warn("Skipping PreviewKit config preflight - repo tree unavailable", {
                    applicationId,
                    organizationId,
                    githubRepositoryId,
                    extra: { repo },
                    err,
                });
                continue;
            }
            if (tree == null || tree.truncated) continue;

            issues.push(...preflightAppsAgainstTree(config, repo, tree.paths));
        }
        return issues;
    }
}

/** Checks the `path`/`dockerfile` of every app of `repo` against that repo's file tree. */
function preflightAppsAgainstTree(config: PreviewConfig, repo: string, treePaths: string[]): ConfigIssue[] {
    const filePaths = new Set(treePaths);
    const directoryPaths = new Set<string>();
    for (const filePath of treePaths) {
        const segments = filePath.split("/");
        for (let depth = 1; depth < segments.length; depth += 1) {
            directoryPaths.add(segments.slice(0, depth).join("/"));
        }
    }

    const issues: ConfigIssue[] = [];
    config.apps.forEach((app, appIndex) => {
        if (!isSameRepository(app.repository, repo)) return;

        const normalizedPath = normalizeRepoPath(app.path);
        if (normalizedPath !== "" && !directoryPaths.has(normalizedPath)) {
            issues.push({
                severity: "warning",
                code: "path_not_found",
                path: ["apps", appIndex, "path"],
                message: `Directory "${app.path}" was not found on the default branch of ${repo}`,
            });
        }

        if (app.dockerfile != null) {
            const buildContext = normalizeRepoPath(app.build_context ?? app.path);
            const dockerfilePath = normalizeRepoPath(
                buildContext === "" ? app.dockerfile : `${buildContext}/${app.dockerfile}`,
            );
            if (!filePaths.has(dockerfilePath) && !filePaths.has(normalizeRepoPath(app.dockerfile))) {
                issues.push({
                    severity: "warning",
                    code: "dockerfile_not_found",
                    path: ["apps", appIndex, "dockerfile"],
                    message: `Dockerfile "${app.dockerfile}" was not found on the default branch of ${repo}`,
                });
            }
        }
    });

    return issues;
}
