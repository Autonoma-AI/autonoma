import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { PreviewRedeployAppMode } from "@autonoma/types";
import { env } from "../../env";
import type { PreviewkitTriggerService } from "../../previewkit/previewkit-trigger.service";
import { Service } from "../service";
import {
    buildPreviewAppSummaries,
    buildServiceSummaries,
    deriveEnvironmentHealth,
    derivePreviewStatus,
    legacyPreviewSummary,
    mapBuildStatus,
    missingPreviewSummary,
    parseStringRecord,
    projectManifest,
    resolvePrimaryUrl,
    toAppBuildOutcomeMap,
} from "./preview-summary";

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
            select: {
                id: true,
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
            },
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

        const latestBuild = environment.builds[0] ?? null;
        const manifest = projectManifest(environment.resolvedConfig);
        const urls = parseStringRecord(environment.urls);
        const primaryUrl = resolvePrimaryUrl(manifest, urls);
        const appBuilds = toAppBuildOutcomeMap(latestBuild?.appBuilds ?? []);
        const services = buildServiceSummaries({
            branchName: branch.name,
            environment,
            manifest,
            latestBuild,
            appBuilds,
        });
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
            status,
            primaryUrl,
            phase: environment.phase,
            error: environment.error,
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
                latestBuild == null
                    ? null
                    : {
                          headSha: latestBuild.headSha,
                          status: mapBuildStatus(latestBuild.status),
                          durationMs: latestBuild.durationMs,
                          error: latestBuild.error,
                          startedAt: latestBuild.startedAt,
                          finishedAt: latestBuild.finishedAt,
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
