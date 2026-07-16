import { type Prisma, type PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { PreviewRedeployAppMode } from "@autonoma/types";
import { env } from "../../env";
import type { PreviewkitTriggerService } from "../../previewkit/previewkit-trigger.service";
import { Service } from "../service";
import {
    buildPreviewAppSummaries,
    buildServiceSummaries,
    deriveDeploymentStatus,
    deriveEnvironmentHealth,
    derivePreviewStatus,
    isBuildingOverPriorAttempt,
    legacyPreviewSummary,
    mapBuildStatus,
    missingPreviewSummary,
    parseStringRecord,
    projectManifest,
    resolvePrimaryUrl,
    toAppBuildOutcomeMap,
} from "./preview-summary";

// Defensive cap on the per-app active-environments list. One env per open PR, so
// a repo realistically stays well under this; the cap only guards a pathological
// backlog of non-torn-down rows.
const ACTIVE_ENVIRONMENTS_LIMIT = 100;

// Cap on the per-environment deployment-history list. One row per pushed commit,
// so a long-lived PR stays well under this; the cap bounds a pathological churn.
const DEPLOYMENT_HISTORY_LIMIT = 50;

// Everything the rich preview-environment summary is assembled from. Shared by
// the PR-keyed and environment-id-keyed lookups so both produce an identical
// summary shape. `repoFullName`/`prNumber` are carried through so the client can
// address the per-environment log stream (keyed by owner/repo/pr) without a
// second round-trip.
const PREVIEWKIT_SUMMARY_ENV_SELECT = {
    id: true,
    repoFullName: true,
    prNumber: true,
    headRef: true,
    githubRepositoryId: true,
    status: true,
    phase: true,
    error: true,
    urls: true,
    resolvedConfig: true,
    headSha: true,
    deployedAt: true,
    tornDownAt: true,
    updatedAt: true,
    appInstances: {
        select: {
            appName: true,
            status: true,
            imageTag: true,
            error: true,
            url: true,
            port: true,
            updatedAt: true,
        },
        orderBy: { appName: "asc" },
    },
    addons: {
        select: {
            name: true,
            provider: true,
            status: true,
            error: true,
            outputs: true,
            provisionedAt: true,
            updatedAt: true,
        },
        orderBy: { name: "asc" },
    },
    builds: {
        select: {
            headSha: true,
            status: true,
            error: true,
            startedAt: true,
            finishedAt: true,
            durationMs: true,
            appBuilds: {
                select: {
                    appName: true,
                    status: true,
                    imageTag: true,
                    durationMs: true,
                    logUrl: true,
                    error: true,
                    runtime: true,
                },
            },
        },
        orderBy: { startedAt: "desc" },
        take: 1,
    },
} satisfies Prisma.PreviewkitEnvironmentSelect;

type PreviewkitSummaryEnvironment = Prisma.PreviewkitEnvironmentGetPayload<{
    select: typeof PREVIEWKIT_SUMMARY_ENV_SELECT;
}>;

export class DeploymentsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly previewkitTrigger: PreviewkitTriggerService,
    ) {
        super();
    }

    /**
     * Lists every Previewkit environment that has not been torn down, across all
     * organizations. An admin-only operational view answering "which preview
     * environments are currently live, what is each app's status, and at what
     * URLs". Ordered most-recently updated first. `apps` carries every configured
     * app with its per-app lifecycle status - not just the ones that reached a
     * URL - sourced from the app-instance rows (see `buildPreviewAppSummaries`).
     * `health` is a reconciled headline status rolled up from the apps + addons
     * (see `deriveEnvironmentHealth`) so the badge never contradicts the app rows;
     * the raw `status`/`phase` are kept for the underlying pipeline state.
     */
    async listActiveEnvironments() {
        this.logger.info("Listing active previewkit environments");

        const environments = await this.db.previewkitEnvironment.findMany({
            where: { status: { not: "torn_down" } },
            orderBy: { updatedAt: "desc" },
            select: {
                id: true,
                namespace: true,
                repoFullName: true,
                prNumber: true,
                headRef: true,
                status: true,
                phase: true,
                urls: true,
                deployedAt: true,
                updatedAt: true,
                organization: { select: { id: true, name: true, slug: true } },
                appInstances: {
                    select: { appName: true, status: true, url: true, error: true },
                    orderBy: { appName: "asc" },
                },
                addons: { select: { status: true } },
            },
        });

        return environments.map((environment) => {
            const apps = buildPreviewAppSummaries(environment.appInstances, parseStringRecord(environment.urls));
            return {
                id: environment.id,
                namespace: environment.namespace,
                repoFullName: environment.repoFullName,
                prNumber: environment.prNumber,
                headRef: environment.headRef,
                status: environment.status,
                phase: environment.phase,
                health: deriveEnvironmentHealth(environment.status, apps, environment.addons),
                organization: environment.organization,
                deployedAt: environment.deployedAt,
                updatedAt: environment.updatedAt,
                apps,
            };
        });
    }

    /**
     * Lists the active (not torn-down) Previewkit environments for a single
     * application, scoped to the caller's organization. The end-user counterpart
     * to `listActiveEnvironments` (which is cross-org and admin-only): it filters
     * to the application's linked GitHub repository so an org only ever sees its
     * own app's previews. Returns `[]` when the app is not linked to a repository
     * (previews are keyed by `githubRepositoryId`). Same per-env shape as the
     * admin view - reconciled `health` rolled up from the app instances so the
     * headline never contradicts the app rows.
     */
    async listActiveEnvironmentsForApp(applicationId: string, organizationId: string) {
        this.logger.info("Listing active previewkit environments for app", { applicationId, organizationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        if (application == null) throw new NotFoundError();

        if (application.githubRepositoryId == null) {
            this.logger.info("Application is not linked to a GitHub repository; no preview environments", {
                applicationId,
            });
            return [];
        }

        const environments = await this.db.previewkitEnvironment.findMany({
            where: {
                organizationId,
                githubRepositoryId: application.githubRepositoryId,
                status: { not: "torn_down" },
            },
            orderBy: { updatedAt: "desc" },
            // Bounded by open PRs on the repo (one env per PR), but capped
            // defensively against a repo accumulating many non-torn-down rows.
            take: ACTIVE_ENVIRONMENTS_LIMIT,
            select: {
                id: true,
                repoFullName: true,
                prNumber: true,
                headRef: true,
                status: true,
                phase: true,
                urls: true,
                deployedAt: true,
                updatedAt: true,
                appInstances: {
                    select: { appName: true, status: true, url: true, error: true },
                    orderBy: { appName: "asc" },
                },
                addons: { select: { status: true } },
            },
        });

        this.logger.info("Listed active previewkit environments for app", {
            applicationId,
            count: environments.length,
        });

        return environments.map((environment) => {
            const apps = buildPreviewAppSummaries(environment.appInstances, parseStringRecord(environment.urls));
            return {
                id: environment.id,
                repoFullName: environment.repoFullName,
                prNumber: environment.prNumber,
                headRef: environment.headRef,
                status: environment.status,
                phase: environment.phase,
                health: deriveEnvironmentHealth(environment.status, apps, environment.addons),
                deployedAt: environment.deployedAt,
                updatedAt: environment.updatedAt,
                apps,
            };
        });
    }

    /**
     * Triggers a redeploy of a preview environment by starting the deploy
     * workflow at the environment's current head SHA - re-runs the full
     * pipeline (all apps) for the PR. Admin-only.
     */
    async redeployEnvironment(environmentId: string): Promise<void> {
        this.logger.info("Redeploying previewkit environment", { environmentId });

        const environment = await this.db.previewkitEnvironment.findUnique({
            where: { id: environmentId },
            select: { repoFullName: true, prNumber: true },
        });
        if (environment == null) {
            throw new NotFoundError("Preview environment not found");
        }

        if (!env.PREVIEWKIT_ENABLED) {
            throw new Error("Preview environments are not configured: PREVIEWKIT_ENABLED is off.");
        }

        await this.previewkitTrigger.redeploy(environment.repoFullName, environment.prNumber);
    }

    /**
     * Triggers a redeploy of a SINGLE app within a preview environment. `mode`
     * "rebuild" rebuilds that app's image at the environment's current head SHA
     * and redeploys only it; "restart" re-rolls its pods using the running
     * image. Sibling apps are left untouched. The trigger service validates that
     * the app exists in the environment. Admin-only.
     */
    async redeployApp(environmentId: string, app: string, mode: PreviewRedeployAppMode): Promise<void> {
        this.logger.info("Redeploying previewkit app", { environmentId, app, mode });

        const environment = await this.db.previewkitEnvironment.findUnique({
            where: { id: environmentId },
            select: { repoFullName: true, prNumber: true },
        });
        if (environment == null) {
            throw new NotFoundError("Preview environment not found");
        }

        if (!env.PREVIEWKIT_ENABLED) {
            throw new Error("Preview environments are not configured: PREVIEWKIT_ENABLED is off.");
        }

        await this.previewkitTrigger.redeployApp(environment.repoFullName, environment.prNumber, app, mode);
    }

    /**
     * Triggers a redeploy of one app after verifying that the preview environment
     * belongs to the requested application and the caller's organization.
     */
    async redeployAppForApplication(
        applicationId: string,
        environmentId: string,
        app: string,
        mode: PreviewRedeployAppMode,
        organizationId: string,
    ): Promise<void> {
        this.logger.info("Redeploying application preview app", {
            application: { applicationId },
            organization: { organizationId },
            extra: { environmentId, app, mode },
        });

        const environment = await this.db.$transaction(async (tx) => {
            const application = await tx.application.findFirst({
                where: { id: applicationId, organizationId },
                select: { githubRepositoryId: true },
            });
            if (application == null || application.githubRepositoryId == null) throw new NotFoundError();

            return await tx.previewkitEnvironment.findFirst({
                where: {
                    id: environmentId,
                    organizationId,
                    githubRepositoryId: application.githubRepositoryId,
                },
                select: { repoFullName: true, prNumber: true },
            });
        });
        if (environment == null) throw new NotFoundError("Preview environment not found");

        if (env.PREVIEWKIT_ENABLED === false) {
            throw new Error("Preview environments are not configured: PREVIEWKIT_ENABLED is off.");
        }

        await this.previewkitTrigger.redeployApp(
            environment.repoFullName,
            environment.prNumber,
            app,
            mode,
            organizationId,
        );

        this.logger.info("Application preview app redeploy triggered", {
            application: { applicationId },
            organization: { organizationId },
            extra: { environmentId, app, mode },
        });
    }

    /**
     * Applications eligible for a main-branch preview deploy: linked to a GitHub
     * repository and owned by an organization with an active GitHub installation,
     * excluding disabled apps. Admin-only picker source for the "deploy main
     * branch" action. Ordered by organization name, then application name.
     */
    async listDeployableApplications() {
        this.logger.info("Listing applications eligible for main-branch preview deploy");

        const applications = await this.db.application.findMany({
            where: {
                disabled: false,
                githubRepositoryId: { not: null },
                organization: { githubInstallation: { status: "active" } },
            },
            orderBy: [{ organization: { name: "asc" } }, { name: "asc" }],
            select: {
                id: true,
                name: true,
                slug: true,
                organization: { select: { id: true, name: true, slug: true } },
            },
        });

        this.logger.info("Listed deployable applications", { count: applications.length });

        return applications.map((application) => ({
            id: application.id,
            name: application.name,
            slug: application.slug,
            organization: application.organization,
        }));
    }

    /**
     * Deploys an Application's main branch into preview environment 0 (the stable
     * non-PR environment) by starting the deploy workflow - the trigger service
     * resolves the repo and branch head from GitHub and validates the
     * application. Admin-only.
     */
    async deployMainBranch(applicationId: string): Promise<void> {
        this.logger.info("Deploying main-branch preview", { applicationId });

        if (!env.PREVIEWKIT_ENABLED) {
            throw new Error("Preview environments are not configured: PREVIEWKIT_ENABLED is off.");
        }

        await this.previewkitTrigger.deployMainBranch(applicationId, undefined);
    }

    async listByPr(applicationId: string, prNumber: number, organizationId: string) {
        this.logger.info("Listing web deployments for PR", { applicationId, prNumber, organizationId });

        const branch = await this.db.branch.findFirst({
            where: {
                applicationId,
                organizationId,
                prInfo: { prNumber },
            },
            select: { id: true },
        });

        if (branch == null) throw new NotFoundError();

        const deployments = await this.db.branchDeployment.findMany({
            where: {
                organizationId,
                branchId: branch.id,
                webDeployment: { isNot: null },
            },
            select: {
                id: true,
                createdAt: true,
                updatedAt: true,
                branch: { select: { id: true, name: true } },
                webDeployment: {
                    select: { url: true, file: true, updatedAt: true },
                },
            },
            orderBy: { updatedAt: "desc" },
        });

        const visible = deployments.filter((d) => d.webDeployment != null && d.webDeployment.url !== "");

        return visible.map((d) => ({
            id: d.id,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
            branch: d.branch,
            url: d.webDeployment!.url,
            file: d.webDeployment!.file,
        }));
    }

    async previewSummaryByPr(applicationId: string, prNumber: number, organizationId: string) {
        this.logger.info("Loading preview environment summary for PR", { applicationId, prNumber, organizationId });

        const branch = await this.db.branch.findFirst({
            where: {
                applicationId,
                organizationId,
                prInfo: { prNumber },
            },
            select: {
                id: true,
                name: true,
                activeSnapshot: { select: { headSha: true } },
                application: { select: { githubRepositoryId: true } },
            },
        });

        if (branch == null) throw new NotFoundError();

        const currentHeadSha = branch.activeSnapshot?.headSha ?? null;

        const githubRepositoryId = branch.application.githubRepositoryId;
        if (githubRepositoryId == null) {
            return missingPreviewSummary(currentHeadSha, "Application is not linked to a GitHub repository.");
        }

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: {
                organizationId,
                githubRepositoryId,
                prNumber,
            },
            select: PREVIEWKIT_SUMMARY_ENV_SELECT,
        });

        if (environment == null) {
            const legacyDeployment = await this.db.branchDeployment.findFirst({
                where: {
                    organizationId,
                    branchId: branch.id,
                    webDeployment: { isNot: null },
                },
                select: {
                    updatedAt: true,
                    webDeployment: {
                        select: {
                            url: true,
                            updatedAt: true,
                        },
                    },
                },
                orderBy: { updatedAt: "desc" },
            });

            if (legacyDeployment?.webDeployment != null && legacyDeployment.webDeployment.url !== "") {
                return legacyPreviewSummary({
                    headSha: currentHeadSha,
                    url: legacyDeployment.webDeployment.url,
                    updatedAt: legacyDeployment.updatedAt,
                    deployedAt: legacyDeployment.webDeployment.updatedAt,
                });
            }

            return missingPreviewSummary(currentHeadSha, "Preview environment is not configured for this PR.");
        }

        return this.buildPreviewkitSummary(environment, currentHeadSha, branch.name);
    }

    /**
     * Loads a preview environment summary by its own id, scoped to the given
     * application (whose slug is in the URL) within the caller's organization.
     * The environment must belong to that application's linked repository, which
     * both ties the URL's `appSlug` to the environment and keeps the branch
     * lookup app-scoped. Unlike `previewSummaryByPr` this never depends on a PR
     * branch existing, so it also serves the main-branch environment (PR #0) that
     * has no pull request. `currentHeadSha` (used only for stale detection) is
     * resolved best-effort from the matching branch and falls back to the
     * environment's deployed SHA - i.e. "not stale" - when no branch is found.
     */
    async previewSummaryById(applicationId: string, environmentId: string, organizationId: string) {
        this.logger.info("Loading preview environment summary by id", { applicationId, environmentId, organizationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        if (application == null || application.githubRepositoryId == null) throw new NotFoundError();

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: { id: environmentId, organizationId, githubRepositoryId: application.githubRepositoryId },
            select: PREVIEWKIT_SUMMARY_ENV_SELECT,
        });
        if (environment == null) throw new NotFoundError();

        const branch = await this.db.branch.findFirst({
            where: { applicationId, organizationId, prInfo: { prNumber: environment.prNumber } },
            // Deterministic when a PR number has been reused (deleted then recreated branch).
            orderBy: { updatedAt: "desc" },
            select: { activeSnapshot: { select: { headSha: true } } },
        });
        const currentHeadSha = branch?.activeSnapshot?.headSha ?? environment.headSha;

        return this.buildPreviewkitSummary(environment, currentHeadSha, environment.headRef);
    }

    /**
     * Loads a preview environment summary for a branch, so the main-branch page can show its preview
     * without knowing the environment id up front. The main branch has no pull request, so its
     * environment is the repository's PR #0; feature branches resolve by their own PR number. Resolved
     * by (repository, PR number) rather than the `branch_id` FK, which is only sparsely backfilled.
     * Returns a `missing` summary when the branch has no preview environment.
     */
    async previewSummaryByBranchId(applicationId: string, branchId: string, organizationId: string) {
        this.logger.info("Loading preview environment summary for branch", { applicationId, branchId, organizationId });

        const branch = await this.db.branch.findFirst({
            where: { id: branchId, applicationId, organizationId },
            select: {
                name: true,
                prInfo: { select: { prNumber: true } },
                activeSnapshot: { select: { headSha: true } },
                application: { select: { githubRepositoryId: true } },
            },
        });
        if (branch == null) throw new NotFoundError();

        const currentHeadSha = branch.activeSnapshot?.headSha ?? null;

        const githubRepositoryId = branch.application.githubRepositoryId;
        if (githubRepositoryId == null) {
            return missingPreviewSummary(currentHeadSha, "Application is not linked to a GitHub repository.");
        }

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: {
                organizationId,
                githubRepositoryId,
                prNumber: branch.prInfo?.prNumber ?? 0,
                status: { not: "torn_down" },
            },
            // Deterministic when a PR number has been reused (deleted then recreated branch).
            orderBy: { updatedAt: "desc" },
            select: PREVIEWKIT_SUMMARY_ENV_SELECT,
        });

        if (environment == null) {
            return missingPreviewSummary(currentHeadSha, "Preview environment is not configured for this branch.");
        }

        return this.buildPreviewkitSummary(environment, currentHeadSha, branch.name);
    }

    /**
     * Lists the deployment history for a single preview environment: one row per
     * pushed commit (a `PreviewkitBuild`), newest first. Scoped like
     * `previewSummaryById` - the environment must belong to the org-scoped
     * application's linked repository. Each row's display status is derived from
     * `error`/`finishedAt` (a successful build is `status='building'` +
     * `finishedAt` + no error), and `isCurrent` flags the commit the environment
     * is presently deployed at.
     */
    async deploymentHistory(applicationId: string, environmentId: string, organizationId: string) {
        this.logger.info("Listing preview deployment history", { applicationId, environmentId, organizationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        if (application == null || application.githubRepositoryId == null) throw new NotFoundError();

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: { id: environmentId, organizationId, githubRepositoryId: application.githubRepositoryId },
            select: { headSha: true },
        });
        if (environment == null) throw new NotFoundError();

        const builds = await this.db.previewkitBuild.findMany({
            where: { environmentId },
            orderBy: { startedAt: "desc" },
            take: DEPLOYMENT_HISTORY_LIMIT,
            select: {
                id: true,
                headSha: true,
                status: true,
                error: true,
                startedAt: true,
                finishedAt: true,
                durationMs: true,
            },
        });

        this.logger.info("Listed preview deployment history", { applicationId, environmentId, count: builds.length });

        return builds.map((build) => ({
            id: build.id,
            headSha: build.headSha,
            status: deriveDeploymentStatus(build),
            startedAt: build.startedAt,
            finishedAt: build.finishedAt,
            durationMs: build.durationMs,
            // `PreviewkitBuild` is `@@unique([environmentId, headSha])`, so at most one row can match
            // the environment's deployed SHA - a same-commit redeploy upserts the existing row.
            isCurrent: build.headSha === environment.headSha,
        }));
    }

    /**
     * Assembles the rich preview-environment summary from an already-loaded
     * environment row: reconciled service list, headline status (with stale
     * detection against `currentHeadSha`), and the latest build. Shared by the
     * PR-keyed and environment-id-keyed lookups so both return the same shape.
     */
    private buildPreviewkitSummary(
        environment: PreviewkitSummaryEnvironment,
        currentHeadSha: string | null,
        branchName: string,
    ) {
        const latestBuild = environment.builds[0] ?? null;
        const buildingOverPriorAttempt = isBuildingOverPriorAttempt(environment.status, latestBuild);
        const effectiveLatestBuild = buildingOverPriorAttempt ? null : latestBuild;
        const manifest = projectManifest(environment.resolvedConfig);
        const urls = parseStringRecord(environment.urls);
        const primaryUrl = resolvePrimaryUrl(manifest, urls);
        const appBuilds = toAppBuildOutcomeMap(effectiveLatestBuild?.appBuilds ?? []);
        const derivedServices = buildServiceSummaries({
            branchName,
            environment,
            manifest,
            latestBuild: effectiveLatestBuild,
            appBuilds,
        });
        const services = buildingOverPriorAttempt
            ? derivedServices.map((service) =>
                  service.status === "failed"
                      ? { ...service, status: "building" as const, statusReason: null }
                      : service,
              )
            : derivedServices;
        const serviceCount = services.length;
        const readyServiceCount = services.filter((service) => service.status === "ready").length;
        const failedServiceCount = services.filter((service) => service.status === "failed").length;
        const degradedServiceCount = services.filter((service) => service.status === "fallback").length;
        const status = derivePreviewStatus({
            previewkitStatus: environment.status,
            currentHeadSha,
            deployedHeadSha: environment.headSha,
            primaryUrl,
            failedServiceCount,
            degradedServiceCount,
        });

        return {
            source: "previewkit" as const,
            environmentId: environment.id,
            repoFullName: environment.repoFullName,
            prNumber: environment.prNumber,
            branch: branchName,
            status,
            primaryUrl,
            phase: environment.phase,
            error: buildingOverPriorAttempt ? null : environment.error,
            headSha: currentHeadSha ?? environment.headSha,
            lastDeployedSha: environment.headSha,
            updatedAt: environment.updatedAt,
            deployedAt: environment.deployedAt,
            serviceCount,
            readyServiceCount,
            degradedServiceCount,
            failedServiceCount,
            services,
            latestBuild:
                effectiveLatestBuild == null
                    ? null
                    : {
                          headSha: effectiveLatestBuild.headSha,
                          status: mapBuildStatus(effectiveLatestBuild.status),
                          durationMs: effectiveLatestBuild.durationMs,
                          error: effectiveLatestBuild.error,
                          startedAt: effectiveLatestBuild.startedAt,
                          finishedAt: effectiveLatestBuild.finishedAt,
                      },
            actions: {
                openPreview: {
                    enabled: primaryUrl != null && status !== "failed" && status !== "missing" && status !== "stopped",
                    href: primaryUrl,
                    reason: primaryUrl == null ? "No preview URL is available yet." : null,
                },
            },
        };
    }
}
