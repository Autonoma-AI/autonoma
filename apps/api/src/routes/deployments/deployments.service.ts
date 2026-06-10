import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { env } from "../../env";
import { previewkitClient } from "../../previewkit/previewkit-service";
import type { PreviewkitTriggerService } from "../../previewkit/previewkit-trigger.service";
import { Service } from "../service";
import {
    buildServiceSummaries,
    derivePreviewStatus,
    legacyPreviewSummary,
    mapBuildStatus,
    missingPreviewSummary,
    parseManifest,
    parseStringRecord,
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
     * environments are currently live, and at what URLs". Ordered most-recently
     * updated first. `apps` is the per-app name -> URL map flattened for display.
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
            },
        });

        return environments.map((environment) => ({
            id: environment.id,
            namespace: environment.namespace,
            repoFullName: environment.repoFullName,
            prNumber: environment.prNumber,
            headRef: environment.headRef,
            status: environment.status,
            phase: environment.phase,
            organization: environment.organization,
            deployedAt: environment.deployedAt,
            updatedAt: environment.updatedAt,
            apps: Object.entries(parseStringRecord(environment.urls)).map(([appName, url]) => ({ appName, url })),
        }));
    }

    /**
     * Triggers a redeploy of a preview environment - re-runs the full pipeline
     * (all apps) for the PR at its current head SHA. Admin-only. With
     * `PREVIEWKIT_USE_TEMPORAL` on, the deploy workflow is started directly;
     * otherwise the request goes through Previewkit's redeploy endpoint
     * (legacy), surfacing Previewkit's own error detail (e.g. 409 torn down).
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

        if (env.PREVIEWKIT_USE_TEMPORAL) {
            await this.previewkitTrigger.redeploy(environment.repoFullName, environment.prNumber);
            return;
        }

        if (!previewkitClient.isConfigured()) {
            throw new Error(
                "Preview environments are not configured: PREVIEWKIT_URL and PREVIEWKIT_SERVICE_SECRET must be set.",
            );
        }

        await previewkitClient.redeploy(environment.repoFullName, environment.prNumber);
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
                lastHandledSha: true,
                application: { select: { githubRepositoryId: true } },
            },
        });

        if (branch == null) throw new NotFoundError();

        const githubRepositoryId = branch.application.githubRepositoryId;
        if (githubRepositoryId == null) {
            return missingPreviewSummary(branch.lastHandledSha, "Application is not linked to a GitHub repository.");
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
                manifest: true,
                headSha: true,
                deployedAt: true,
                tornDownAt: true,
                updatedAt: true,
                appInstances: {
                    select: {
                        appName: true,
                        imageTag: true,
                        url: true,
                        port: true,
                        ready: true,
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
                    headSha: branch.lastHandledSha,
                    url: legacyDeployment.webDeployment.url,
                    updatedAt: legacyDeployment.updatedAt,
                    deployedAt: legacyDeployment.webDeployment.updatedAt,
                });
            }

            return missingPreviewSummary(branch.lastHandledSha, "Preview environment is not configured for this PR.");
        }

        const latestBuild = environment.builds[0] ?? null;
        const manifest = parseManifest(environment.manifest);
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
            currentHeadSha: branch.lastHandledSha,
            deployedHeadSha: environment.headSha,
            primaryUrl,
            failedServiceCount,
            degradedServiceCount,
        });

        return {
            status,
            primaryUrl,
            phase: environment.phase,
            error: environment.error,
            headSha: branch.lastHandledSha ?? environment.headSha,
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
