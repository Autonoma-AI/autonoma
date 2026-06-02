import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { Service } from "../service";
import {
    buildServiceSummaries,
    derivePreviewStatus,
    legacyPreviewSummary,
    mapBuildStatus,
    missingPreviewSummary,
    parseAppBuilds,
    parseManifest,
    parseStringRecord,
    resolvePrimaryUrl,
} from "./preview-summary";

export class DeploymentsService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
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
                        appBuilds: true,
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
        const appBuilds = parseAppBuilds(latestBuild?.appBuilds);
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
