import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import {
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
    createAndActivateRevision,
    defaultPreviewkitConfig,
    mergeConfigsForValidation,
    normalizeRepoPath,
    parseConfigShapeOrThrow,
} from "./previewkit-config-helpers";

export interface OnboardingPreviewkitDependencyConfig {
    /** The multirepo alias from `config.multirepo.repos[].name`. */
    name: string;
    /** Repo full name (`owner/repo`). */
    repo: string;
    githubRepositoryId?: number;
    applicationId?: string;
    saved: boolean;
    revisionId?: string;
    revision?: number;
    document?: PreviewConfig;
}

export interface OnboardingPreviewkitConfig {
    applicationId: string;
    saved: boolean;
    revisionId?: string;
    revision?: number;
    document: PreviewConfig;
    /** One entry per dependency repo declared in the primary document's `config.multirepo.repos`. */
    dependencyConfigs: OnboardingPreviewkitDependencyConfig[];
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
 * (plus dependency-repo configs), saving multi-repo revisions atomically, and
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

    async getConfig(applicationId: string, organizationId: string): Promise<OnboardingPreviewkitConfig> {
        this.logger.info("Loading onboarding PreviewKit config", { applicationId, organizationId });
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                id: true,
                activeConfigRevisionId: true,
            },
        });
        if (application == null) throw new NotFoundError("Application not found");

        if (application.activeConfigRevisionId == null) {
            return {
                applicationId,
                saved: false,
                document: defaultPreviewkitConfig(),
                dependencyConfigs: [],
            };
        }

        const revision = await this.db.previewkitConfigRevision.findFirst({
            where: { id: application.activeConfigRevisionId, applicationId },
            select: {
                id: true,
                revision: true,
                document: true,
            },
        });
        if (revision == null) {
            return {
                applicationId,
                saved: false,
                document: defaultPreviewkitConfig(),
                dependencyConfigs: [],
            };
        }

        const validation = previewConfigSchema.safeParse(revision.document);
        if (!validation.success) {
            throw new ConflictError(`Active PreviewKit config is invalid: ${z.prettifyError(validation.error)}`);
        }

        return {
            applicationId,
            saved: true,
            revisionId: revision.id,
            revision: revision.revision,
            document: validation.data,
            dependencyConfigs: await this.loadDependencyConfigs(organizationId, validation.data),
        };
    }

    /**
     * Resolves each dependency repo declared in the primary document onto the
     * org's Application rows and their active config revisions. GitHub being
     * unreachable degrades to unsaved entries (alias + repo only) - the config
     * screen must stay usable without GitHub.
     */
    private async loadDependencyConfigs(
        organizationId: string,
        primaryConfig: PreviewConfig,
    ): Promise<OnboardingPreviewkitDependencyConfig[]> {
        const repos = primaryConfig.config?.multirepo?.repos ?? [];
        if (repos.length === 0) return [];

        const repoByFullName = await this.resolveInstallationRepos(organizationId);

        return await Promise.all(
            repos.map(async (dep): Promise<OnboardingPreviewkitDependencyConfig> => {
                const entry: OnboardingPreviewkitDependencyConfig = {
                    name: dep.name,
                    repo: dep.repo,
                    saved: false,
                };

                const githubRepo = repoByFullName?.get(dep.repo);
                if (githubRepo == null) return entry;
                entry.githubRepositoryId = githubRepo.id;

                const application = await this.db.application.findUnique({
                    where: {
                        organizationId_githubRepositoryId: {
                            organizationId,
                            githubRepositoryId: githubRepo.id,
                        },
                    },
                    select: { id: true, activeConfigRevisionId: true },
                });
                if (application == null) return entry;
                entry.applicationId = application.id;
                if (application.activeConfigRevisionId == null) return entry;

                const revision = await this.db.previewkitConfigRevision.findFirst({
                    where: { id: application.activeConfigRevisionId, applicationId: application.id },
                    select: { id: true, revision: true, document: true },
                });
                if (revision == null) return entry;

                const parsed = previewConfigSchema.safeParse(revision.document);
                if (!parsed.success) {
                    this.logger.warn("Dependency repo has an invalid active config revision", {
                        organizationId,
                        repo: dep.repo,
                        revisionId: revision.id,
                    });
                    return entry;
                }

                entry.saved = true;
                entry.revisionId = revision.id;
                entry.revision = revision.revision;
                entry.document = parsed.data;
                return entry;
            }),
        );
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
        userId: string,
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
        const blockingIssues = validatePreviewConfigSemantics(merged).filter((issue) => issue.severity === "error");
        if (blockingIssues.length > 0) {
            const issueText = blockingIssues
                .map((issue) => {
                    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
                    return `${path}${issue.message}`;
                })
                .join("; ");
            throw new BadRequestError(`Invalid PreviewKit config: ${issueText}`);
        }

        // One transaction for every revision so a multi-repo save can never
        // activate the primary topology while a dependency's half is missing.
        const created = await this.db.$transaction(async (tx) => {
            const primary = await createAndActivateRevision(tx, applicationId, config, userId);
            const dependencyRows = await Promise.all(
                dependencies.map(async (dependency) => ({
                    dependency,
                    row: await createAndActivateRevision(tx, dependency.applicationId, dependency.config, userId),
                })),
            );
            return { primary, dependencyRows };
        });

        return {
            applicationId,
            saved: true,
            revisionId: created.primary.id,
            revision: created.primary.revision,
            document: config,
            dependencyConfigs: created.dependencyRows.map(({ dependency, row }) => ({
                name: dependency.alias,
                repo: dependency.repo,
                githubRepositoryId: dependency.githubRepositoryId,
                applicationId: dependency.applicationId,
                saved: true,
                revisionId: row.id,
                revision: row.revision,
                document: dependency.config,
            })),
        };
    }

    /**
     * Validates each dependency document, checks merged-topology name uniqueness,
     * and resolves (creating + linking when missing) the dependency repos'
     * Application rows. Application creation happens outside the revision
     * transaction - it's idempotent on retry, while revision activation must be
     * all-or-nothing.
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
            applicationId: string;
            config: PreviewConfig;
        }>
    > {
        if (dependencyDocuments.length === 0) return [];

        const github = this.options.github;
        const applications = this.options.applications;
        if (github == null || applications == null) {
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
            applicationId: string;
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

            const applicationId = await this.findOrCreateDependencyApplication(organizationId, githubRepo);
            prepared.push({
                alias,
                repo: dependencyDocument.repo,
                githubRepositoryId: githubRepo.id,
                applicationId,
                config,
            });
        }

        return prepared;
    }

    private async findOrCreateDependencyApplication(
        organizationId: string,
        repo: OnboardingGithubRepository,
    ): Promise<string> {
        const existing = await this.db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId: repo.id } },
            select: { id: true },
        });
        if (existing != null) return existing.id;

        const applications = this.options.applications;
        const github = this.options.github;
        if (applications == null || github == null) {
            throw new BadRequestError("GitHub is not configured for this environment");
        }

        this.logger.info("Creating Application for dependency repo", {
            organizationId,
            repo: repo.fullName,
            githubRepositoryId: repo.id,
        });

        let created: { id: string };
        try {
            created = await applications.createMinimalApplication(repo.name, organizationId);
        } catch (err) {
            if (err instanceof ConflictError) {
                // Application name collision - retry with the owner-qualified name.
                created = await applications.createMinimalApplication(repo.fullName.replace("/", "-"), organizationId);
            } else {
                throw err;
            }
        }

        await github.linkRepository(organizationId, created.id, repo.id);
        return created.id;
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

        const parsed = previewConfigSchema.safeParse(document);
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
