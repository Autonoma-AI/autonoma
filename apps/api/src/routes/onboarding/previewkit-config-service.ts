import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import {
    authoringPreviewConfigSchema,
    previewConfigSchema,
    validatePreviewConfigSemantics,
    zodIssuesToConfigIssues,
    type ConfigIssue,
    type PreviewConfig,
} from "@autonoma/types";
import { z } from "zod";
import type { OnboardingGithubRepository, OnboardingManagerOptions } from "./onboarding-dependencies";
import {
    collectTopologyNames,
    defaultPreviewkitConfig,
    filterDockerfilePaths,
    mergeConfigsForValidation,
    normalizeRepoPath,
    parseConfigShapeOrThrow,
    parseStoredDependencyDocuments,
    upsertConfig,
} from "./previewkit-config-helpers";

export interface OnboardingPreviewkitDependencyConfig {
    /** The multirepo alias from `config.multirepo.repos[].name`. */
    name: string;
    /** Repo full name (`owner/repo`). */
    repo: string;
    githubRepositoryId?: number;
    applicationId?: string;
    saved: boolean;
    document?: PreviewConfig;
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
    /** One entry per dependency repo declared in the primary document's `config.multirepo.repos`. */
    dependencyConfigs: OnboardingPreviewkitDependencyConfig[];
    /**
     * Warning-severity semantic issues on the saved (merged) topology. Only set by
     * `save`: errors block the save, but warnings would otherwise vanish silently -
     * and the MCP agent path has no other channel to hear about them (e.g. a
     * database service no app connection references).
     */
    warnings?: ConfigIssue[];
}

export interface PreviewkitDependencyDocument {
    /** Repo full name (`owner/repo`) - must be declared in the primary document's `config.multirepo.repos`. */
    repo: string;
    document: unknown;
}

export interface PreviewkitConfigValidationResult {
    /** True when no `error`-severity issue was found. Warnings never flip this. */
    valid: boolean;
    issues: ConfigIssue[];
}

/**
 * Owns the PreviewKit config domain for onboarding: loading the active config
 * (plus dependency-repo configs), saving the multi-repo config (latest-only), and
 * validating documents. The caller ({@link OnboardingManager}) is responsible
 * for the onboarding-state guards (repo linked, step reached) before delegating.
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
                mainBranch: { select: { name: true } },
                previewkitConfig: { select: { document: true, dependencyDocuments: true } },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const deployBranch = application.mainBranch?.name ?? undefined;
        const stored = application.previewkitConfig;
        if (stored == null) {
            return {
                applicationId,
                saved: false,
                document: defaultPreviewkitConfig(application.name),
                dependencyConfigs: [],
                deployBranch,
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
            dependencyConfigs: await this.loadDependencyConfigs(
                applicationId,
                organizationId,
                validation.data,
                stored.dependencyDocuments,
            ),
        };
    }

    /**
     * Builds the dependency-config entries for each repo declared in the primary
     * document's `config.multirepo.repos`, sourcing each config from the primary
     * config's stored `dependencyDocuments` (dependency repos are not separate
     * Applications). GitHub is consulted only to resolve each repo's id for the
     * UI; being unreachable degrades to entries without it. The owning
     * `applicationId` is the primary app - dependency-app secrets live there.
     */
    private async loadDependencyConfigs(
        primaryApplicationId: string,
        organizationId: string,
        primaryConfig: PreviewConfig,
        storedDependencyDocuments: unknown,
    ): Promise<OnboardingPreviewkitDependencyConfig[]> {
        const repos = primaryConfig.config?.multirepo?.repos ?? [];
        if (repos.length === 0) return [];

        const { documents, invalid } = parseStoredDependencyDocuments(storedDependencyDocuments);
        if (invalid) {
            this.logger.warn("Stored dependencyDocuments did not validate; treating as empty", {
                organizationId,
                applicationId: primaryApplicationId,
            });
        }
        const documentByRepo = new Map(documents.map((entry) => [entry.repo, entry.document]));
        const repoByFullName = await this.resolveInstallationRepos(organizationId);

        return repos.map((dep): OnboardingPreviewkitDependencyConfig => {
            const document = documentByRepo.get(dep.repo);
            const githubRepo = repoByFullName?.get(dep.repo);
            return {
                name: dep.name,
                repo: dep.repo,
                githubRepositoryId: githubRepo?.id,
                applicationId: primaryApplicationId,
                saved: document != null,
                document,
            };
        });
    }

    /** Lists the org installation's repos keyed by full name; undefined when GitHub is unavailable. */
    private async resolveInstallationRepos(
        organizationId: string,
    ): Promise<Map<string, OnboardingGithubRepository> | undefined> {
        const github = this.options.github;
        if (github == null) return undefined;
        try {
            const repos = await github.listRepositories(organizationId);
            return new Map(repos.map((repo) => [repo.fullName, repo]));
        } catch (err) {
            this.logger.warn("Failed to list installation repositories", { organizationId, err });
            return undefined;
        }
    }

    async save(
        applicationId: string,
        organizationId: string,
        document: unknown,
        dependencyDocuments: PreviewkitDependencyDocument[] = [],
    ): Promise<OnboardingPreviewkitConfig> {
        this.logger.info("Saving onboarding PreviewKit config", {
            applicationId,
            organizationId,
            dependencyCount: dependencyDocuments.length,
        });

        const config = parseConfigShapeOrThrow(document);
        const dependencies = await this.prepareDependencySaves(organizationId, config, dependencyDocuments);

        // Semantic checks (depends_on, primary, hooks) run on the MERGED topology -
        // mirroring how the pipeline concatenates every repo's config at deploy -
        // so a dependency app may legitimately depend on a primary-repo service.
        const merged = mergeConfigsForValidation(
            config,
            dependencies.map((dependency) => dependency.config),
        );
        const issues = validatePreviewConfigSemantics(merged);
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

        await upsertConfig(
            this.db,
            applicationId,
            config,
            dependencies.map((dependency) => ({ repo: dependency.repo, document: dependency.config })),
        );

        return {
            applicationId,
            saved: true,
            document: config,
            dependencyConfigs: dependencies.map((dependency) => ({
                name: dependency.alias,
                repo: dependency.repo,
                githubRepositoryId: dependency.githubRepositoryId,
                // Dependency-app secrets live under the primary Application.
                applicationId,
                saved: true,
                document: dependency.config,
            })),
            warnings,
        };
    }

    /**
     * Validates each dependency document, checks merged-topology name uniqueness,
     * and resolves each dependency repo's GitHub id (for the UI / clone). Does NOT
     * create Applications - the dependency configs are stored on the primary
     * config and the deploy clones each repo for source only.
     */
    private async prepareDependencySaves(
        organizationId: string,
        primaryConfig: PreviewConfig,
        dependencyDocuments: PreviewkitDependencyDocument[],
    ): Promise<
        Array<{
            alias: string;
            repo: string;
            githubRepositoryId: number;
            config: PreviewConfig;
        }>
    > {
        if (dependencyDocuments.length === 0) return [];

        const github = this.options.github;
        if (github == null) {
            throw new BadRequestError("GitHub is not configured for this environment");
        }

        const declaredRepos = new Map(
            (primaryConfig.config?.multirepo?.repos ?? []).map((dep) => [dep.repo, dep.name]),
        );
        const duplicateCheck = new Set(dependencyDocuments.map((dep) => dep.repo));
        if (duplicateCheck.size !== dependencyDocuments.length) {
            throw new BadRequestError("Duplicate dependency repo in save request");
        }

        const repoByFullName = await this.resolveInstallationRepos(organizationId);
        if (repoByFullName == null) {
            throw new BadRequestError("GitHub installation repositories could not be listed");
        }

        const seenNames = new Map<string, string>();
        collectTopologyNames(primaryConfig, "primary repo", seenNames);

        const prepared: Array<{
            alias: string;
            repo: string;
            githubRepositoryId: number;
            config: PreviewConfig;
        }> = [];

        for (const dependencyDocument of dependencyDocuments) {
            const alias = declaredRepos.get(dependencyDocument.repo);
            if (alias == null) {
                throw new BadRequestError(
                    `Dependency repo "${dependencyDocument.repo}" is not declared in the primary config's multirepo.repos`,
                );
            }

            const githubRepo = repoByFullName.get(dependencyDocument.repo);
            if (githubRepo == null) {
                throw new BadRequestError(
                    `Repository "${dependencyDocument.repo}" is not accessible to the GitHub installation`,
                );
            }

            let config: PreviewConfig;
            try {
                config = parseConfigShapeOrThrow(dependencyDocument.document);
            } catch (err) {
                if (err instanceof BadRequestError) {
                    throw new BadRequestError(`Config for "${dependencyDocument.repo}" is invalid: ${err.message}`);
                }
                throw err;
            }
            collectTopologyNames(config, dependencyDocument.repo, seenNames);

            prepared.push({
                alias,
                repo: dependencyDocument.repo,
                githubRepositoryId: githubRepo.id,
                config,
            });
        }

        return prepared;
    }

    /**
     * Validates a PreviewKit config document and returns every finding as data
     * (never throws for findings - tRPC errors flatten to message strings, which
     * the dashboard cannot map back to form fields). Runs schema validation,
     * semantic checks, and - when GitHub access is available - repo-aware
     * preflight checks against the target repository's file tree.
     */
    async validate(
        applicationId: string,
        organizationId: string,
        document: unknown,
        githubRepositoryId?: number,
    ): Promise<PreviewkitConfigValidationResult> {
        this.logger.info("Validating onboarding PreviewKit config", {
            applicationId,
            organizationId,
            githubRepositoryId,
        });

        // The authoring contract, matching `parseConfigShapeOrThrow`: this backs the
        // editor's live validation, so it must report exactly what a save would
        // reject - including an app still on a retired framework preset.
        const parsed = authoringPreviewConfigSchema.safeParse(document);
        if (!parsed.success) {
            return { valid: false, issues: zodIssuesToConfigIssues(parsed.error) };
        }

        const issues = validatePreviewConfigSemantics(parsed.data);
        issues.push(
            ...(await this.preflightPreviewkitConfig(applicationId, organizationId, parsed.data, githubRepositoryId)),
        );

        return { valid: !issues.some((issue) => issue.severity === "error"), issues };
    }

    /**
     * Repo-aware preflight: checks that each app's `path` (and explicit
     * `dockerfile`) exists in the target repo's file tree. Findings are warnings,
     * not errors - the active branch may differ from what the user is about to
     * push. Skips silently when GitHub introspection is unavailable.
     */
    private async preflightPreviewkitConfig(
        applicationId: string,
        organizationId: string,
        config: PreviewConfig,
        githubRepositoryId?: number,
    ): Promise<ConfigIssue[]> {
        const introspection = this.options.repoIntrospection;
        if (introspection == null) return [];

        let tree: { paths: string[]; truncated: boolean } | undefined;
        try {
            tree = await introspection.getRepoTree(organizationId, applicationId, githubRepositoryId);
        } catch (err) {
            this.logger.warn("Skipping PreviewKit config preflight - repo tree unavailable", {
                applicationId,
                organizationId,
                githubRepositoryId,
                err,
            });
            return [];
        }
        if (tree == null || tree.truncated) return [];

        const filePaths = new Set(tree.paths);
        const directoryPaths = new Set<string>();
        for (const filePath of tree.paths) {
            const segments = filePath.split("/");
            for (let depth = 1; depth < segments.length; depth += 1) {
                directoryPaths.add(segments.slice(0, depth).join("/"));
            }
        }

        const issues: ConfigIssue[] = [];
        config.apps.forEach((app, appIndex) => {
            const normalizedPath = normalizeRepoPath(app.path);
            if (normalizedPath !== "" && !directoryPaths.has(normalizedPath)) {
                issues.push({
                    severity: "warning",
                    code: "path_not_found",
                    path: ["apps", appIndex, "path"],
                    message: `Directory "${app.path}" was not found on the repository's default branch`,
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
                        message: `Dockerfile "${app.dockerfile}" was not found on the repository's default branch`,
                    });
                }
            }
        });

        return issues;
    }
}
