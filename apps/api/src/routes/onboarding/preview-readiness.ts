import {
    type OnboardingPreviewEnvironmentMode,
    type OnboardingPreviewVerificationStatus,
    type OnboardingStep,
    type Prisma,
    type PrismaClient,
} from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { previewConfigSchema } from "@autonoma/types";
import {
    buildServiceSummaries,
    classifyPreviewFailures,
    derivePreviewStatus,
    parseStringRecord,
    projectManifest,
    resolvePrimaryUrl,
    toAppBuildOutcomeMap,
    type PreviewFailure,
} from "../deployments/preview-summary";

export type PreviewDiagnosticsAction = "edit_config" | "edit_secrets" | "redeploy" | "copy_for_agent";
export type PreviewDiagnosticsStatus = "idle" | "building" | "ready" | "failed";

/**
 * When available, the live build-log stream for the main preview environment can
 * be mounted against `GET /v1/previewkit/environments/{owner}/{repo}/{prNumber}/logs/stream`.
 */
export type PreviewDiagnosticsLogs = { available: false } | { available: true; repoFullName: string; prNumber: number };

export interface PreviewDiagnostics {
    status: PreviewDiagnosticsStatus;
    phase?: string;
    error?: string;
    /** Structured failures with config field pointers, when derivable. */
    failures?: PreviewFailure[];
    actions: PreviewDiagnosticsAction[];
    logs: PreviewDiagnosticsLogs;
}

export interface PreviewReadinessService {
    name: string;
    status: "ready" | "building" | "failed" | "unknown";
    url?: string;
    port?: number;
    error?: string;
}

export interface PreviewReadiness {
    mode?: OnboardingPreviewEnvironmentMode;
    previewUrl?: string;
    diagnostics: PreviewDiagnostics;
    services: PreviewReadinessService[];
}

const MAIN_BRANCH_PREVIEW_ENVIRONMENT_NUMBER = 0;
const PREVIEWKIT_DEPLOY_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

const previewkitEnvironmentSelect = {
    id: true,
    repoFullName: true,
    resolvedConfig: true,
    status: true,
    phase: true,
    error: true,
    urls: true,
    headSha: true,
    headRef: true,
    deployedAt: true,
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
            appBuilds: true,
        },
        orderBy: { startedAt: "desc" },
        take: 1,
    },
} satisfies Prisma.PreviewkitEnvironmentSelect;

type PreviewkitEnvironmentReadinessRow = Prisma.PreviewkitEnvironmentGetPayload<{
    select: typeof previewkitEnvironmentSelect;
}>;

function hasPreviewkitEnvironmentActivitySince(
    environment: PreviewkitEnvironmentReadinessRow,
    deployRequestedAt: Date,
): boolean {
    if (environment.updatedAt.getTime() >= deployRequestedAt.getTime()) return true;

    const latestBuild = environment.builds[0];
    if (latestBuild != null) {
        if (latestBuild.startedAt.getTime() >= deployRequestedAt.getTime()) return true;
        if (latestBuild.finishedAt != null && latestBuild.finishedAt.getTime() >= deployRequestedAt.getTime())
            return true;
    }

    for (const appInstance of environment.appInstances) {
        if (appInstance.updatedAt.getTime() >= deployRequestedAt.getTime()) return true;
    }

    for (const addon of environment.addons) {
        if (addon.updatedAt.getTime() >= deployRequestedAt.getTime()) return true;
    }

    return false;
}

function shouldPersistPreviewVerificationStatus(
    step: OnboardingStep,
    previousStatus: PreviewDiagnosticsStatus,
    nextStatus: PreviewDiagnosticsStatus,
): boolean {
    if (nextStatus !== previousStatus) return true;
    if (nextStatus !== "building") return false;
    return step !== "previewkit_deploying";
}

export function idleReadiness(mode?: OnboardingPreviewEnvironmentMode): PreviewReadiness {
    return {
        ...(mode != null ? { mode } : {}),
        diagnostics: {
            status: "idle",
            actions: ["edit_config"],
            logs: { available: false },
        },
        services: [],
    };
}

function failedReadiness(
    error: string,
    actions: PreviewDiagnosticsAction[],
    mode?: OnboardingPreviewEnvironmentMode,
): PreviewReadiness {
    return {
        ...(mode != null ? { mode } : {}),
        diagnostics: {
            status: "failed",
            error,
            actions,
            logs: { available: false },
        },
        services: [],
    };
}

function isPreviewkitDeployRequestExpired(updatedAt: Date): boolean {
    return Date.now() - updatedAt.getTime() > PREVIEWKIT_DEPLOY_REQUEST_TIMEOUT_MS;
}

function diagnosticsFromPreviewStatus({
    status,
    phase,
    error,
    primaryUrl,
    logs,
    failures,
}: {
    status: ReturnType<typeof derivePreviewStatus>;
    phase?: string;
    error?: string;
    primaryUrl: string | null;
    logs: PreviewDiagnosticsLogs;
    failures: PreviewFailure[];
}): PreviewDiagnostics {
    if (status === "ready") {
        return {
            status: "ready",
            ...(phase != null ? { phase } : {}),
            actions: ["copy_for_agent"],
            logs,
        };
    }

    if (status === "building" || status === "stale") {
        return {
            status: "building",
            ...(phase != null ? { phase } : {}),
            ...(error != null ? { error } : {}),
            actions: ["redeploy", "copy_for_agent"],
            logs,
        };
    }

    if (status === "missing") {
        return {
            status: "idle",
            error: error ?? "PreviewKit has not created an environment yet.",
            actions: ["redeploy", "edit_config"],
            logs,
        };
    }

    return {
        status: "failed",
        ...(phase != null ? { phase } : {}),
        error: error ?? (primaryUrl == null ? "No preview URL is available." : "Preview environment is degraded."),
        ...(failures.length > 0 ? { failures } : {}),
        actions: ["edit_config", "edit_secrets", "redeploy", "copy_for_agent"],
        logs,
    };
}

function toReadinessServiceStatus(status: string): PreviewReadinessService["status"] {
    if (status === "ready" || status === "building" || status === "failed") return status;
    return "unknown";
}

export async function buildExistingDeploysReadiness(
    db: PrismaClient,
    applicationId: string,
    step: OnboardingStep,
    previewVerificationStatus: OnboardingPreviewVerificationStatus,
    previewUrl?: string,
): Promise<PreviewReadiness> {
    if (previewUrl == null || previewUrl.length === 0) {
        return {
            mode: "existing_deploys",
            diagnostics: {
                status: "idle",
                actions: ["copy_for_agent"],
                logs: { available: false },
            },
            services: [],
        };
    }

    // Only persist the verified transition once. Readiness is polled, so
    // re-writing on every poll bumps `updatedAt` (breaking the signal
    // `acceptedAt` reading) and would roll a `completed` onboarding back.
    const alreadyVerified = step === "preview_verified" && previewVerificationStatus === "ready";
    const isCompleted = step === "completed";
    if (!alreadyVerified && !isCompleted) {
        await db.onboardingState.update({
            where: { applicationId },
            data: {
                step: "preview_verified",
                previewUrl,
                productionUrl: previewUrl,
                previewVerificationStatus: "ready",
            },
        });
    }

    return {
        mode: "existing_deploys",
        previewUrl,
        diagnostics: {
            status: "ready",
            actions: ["copy_for_agent"],
            logs: { available: false },
        },
        services: [],
    };
}

export async function buildPreviewkitReadiness(
    db: PrismaClient,
    applicationId: string,
    organizationId: string,
    step: OnboardingStep,
    previousStatus: PreviewDiagnosticsStatus,
    previousStatusUpdatedAt: Date,
): Promise<PreviewReadiness> {
    // Once onboarding is completed, report readiness but never persist a
    // status/step change - that would roll a finished onboarding backward.
    const isCompleted = step === "completed";
    const application = await db.application.findFirst({
        where: { id: applicationId, organizationId },
        select: {
            githubRepositoryId: true,
            activeConfigRevisionId: true,
            mainBranch: { select: { name: true, activeSnapshot: { select: { headSha: true } } } },
        },
    });

    if (application == null) throw new NotFoundError("Application not found");
    if (application.githubRepositoryId == null) {
        return failedReadiness("Application is not linked to a GitHub repository.", ["edit_config"]);
    }
    if (previousStatus === "idle") {
        return {
            mode: "previewkit",
            diagnostics: {
                status: "idle",
                phase: "workflow_not_started",
                error: "No PreviewKit deploy has been started for this onboarding config yet.",
                actions: ["redeploy", "edit_config", "copy_for_agent"],
                logs: { available: false },
            },
            services: [],
        };
    }

    const environment = await db.previewkitEnvironment.findFirst({
        where: {
            organizationId,
            githubRepositoryId: application.githubRepositoryId,
            prNumber: MAIN_BRANCH_PREVIEW_ENVIRONMENT_NUMBER,
        },
        select: previewkitEnvironmentSelect,
    });

    if (environment == null) {
        if (previousStatus === "building") {
            if (isPreviewkitDeployRequestExpired(previousStatusUpdatedAt)) {
                const readiness = failedReadiness(
                    "PreviewKit accepted the deploy request, but no environment was created. Check PreviewKit service health, then redeploy.",
                    ["redeploy", "edit_config", "copy_for_agent"],
                    "previewkit",
                );
                if (!isCompleted) {
                    await db.onboardingState.update({
                        where: { applicationId },
                        data: { previewVerificationStatus: "failed" },
                    });
                }

                return readiness;
            }

            return {
                mode: "previewkit",
                diagnostics: {
                    status: "building",
                    phase: "deploy_requested",
                    actions: ["redeploy", "edit_config", "copy_for_agent"],
                    logs: { available: false },
                },
                services: [],
            };
        }

        return {
            mode: "previewkit",
            diagnostics: {
                status: "idle",
                phase: "workflow_not_started",
                error: "No PreviewKit environment row exists yet. Start or redeploy the main environment after saving config.",
                actions: ["redeploy", "edit_config", "copy_for_agent"],
                logs: { available: false },
            },
            services: [],
        };
    }
    const environmentHasActivityForDeploy = hasPreviewkitEnvironmentActivitySince(environment, previousStatusUpdatedAt);
    if (previousStatus === "building" && !environmentHasActivityForDeploy) {
        if (isPreviewkitDeployRequestExpired(previousStatusUpdatedAt)) {
            const readiness = failedReadiness(
                "PreviewKit accepted the deploy request, but no new build activity has started for this deploy. Check PreviewKit service health, then redeploy.",
                ["redeploy", "edit_config", "copy_for_agent"],
                "previewkit",
            );
            if (!isCompleted) {
                await db.onboardingState.update({
                    where: { applicationId },
                    data: { previewVerificationStatus: "failed" },
                });
            }

            return readiness;
        }

        return {
            mode: "previewkit",
            diagnostics: {
                status: "building",
                phase: "deploy_requested",
                actions: ["redeploy", "edit_config", "copy_for_agent"],
                logs: { available: false },
            },
            services: [],
        };
    }

    const latestBuild = environment.builds[0] ?? null;
    const manifest = projectManifest(environment.resolvedConfig);
    const urls = parseStringRecord(environment.urls);
    const primaryUrl = resolvePrimaryUrl(manifest, urls);
    const appBuilds = toAppBuildOutcomeMap(latestBuild?.appBuilds ?? []);
    const services = buildServiceSummaries({
        branchName: application.mainBranch?.name ?? environment.headRef,
        environment,
        manifest,
        latestBuild,
        appBuilds,
    });
    const failedServiceCount = services.filter((service) => service.status === "failed").length;
    const degradedServiceCount = services.filter((service) => service.status === "fallback").length;
    const previewStatus = derivePreviewStatus({
        previewkitStatus: environment.status,
        currentHeadSha: application.mainBranch?.activeSnapshot?.headSha ?? environment.headSha,
        deployedHeadSha: environment.headSha,
        primaryUrl,
        failedServiceCount,
        degradedServiceCount,
    });

    const logs: PreviewDiagnosticsLogs = {
        available: true,
        repoFullName: environment.repoFullName,
        prNumber: MAIN_BRANCH_PREVIEW_ENVIRONMENT_NUMBER,
    };
    const failures = classifyPreviewFailures({
        appBuilds,
        services,
        environmentError: environment.error ?? latestBuild?.error ?? undefined,
        appIndexByName: await resolveFailureAppIndexes(
            db,
            environment.resolvedConfig,
            applicationId,
            application.activeConfigRevisionId,
        ),
    });
    const diagnostics = diagnosticsFromPreviewStatus({
        status: previewStatus,
        phase: environment.phase ?? undefined,
        error: environment.error ?? latestBuild?.error ?? undefined,
        primaryUrl,
        logs,
        failures,
    });

    if (diagnostics.status === "ready" && primaryUrl != null) {
        // writePreviewUrl is itself guarded against downgrading a completed row.
        await writePreviewUrl(db, { applicationId, organizationId, previewUrl: primaryUrl });
    } else if (!isCompleted && shouldPersistPreviewVerificationStatus(step, previousStatus, diagnostics.status)) {
        await db.onboardingState.update({
            where: { applicationId },
            data: {
                previewVerificationStatus: diagnostics.status,
                ...(diagnostics.status === "building" ? { step: "previewkit_deploying" } : {}),
            },
        });
    }

    return {
        mode: "previewkit",
        ...(primaryUrl != null ? { previewUrl: primaryUrl } : {}),
        diagnostics,
        services: services.map((service) => ({
            name: service.name,
            status: toReadinessServiceStatus(service.status),
            ...(service.endpoint != null ? { url: service.endpoint } : {}),
            ...(service.port != null ? { port: service.port } : {}),
            ...(service.statusReason != null ? { error: service.statusReason } : {}),
        })),
    };
}

/**
 * App-name -> index map used to point structured failures at
 * `apps.<i>.<field>` paths. Prefers the environment's resolved (merged)
 * config snapshot - it covers dependency-repo apps too, which the primary
 * revision alone does not - and falls back to the active revision. The UI
 * deep-links via app name plus the path's field segment, so an index from
 * the merged document is sufficient. Best-effort: when neither parses, the
 * map is empty and failures carry no fieldPath.
 */
async function resolveFailureAppIndexes(
    db: PrismaClient,
    resolvedConfig: Prisma.JsonValue | null,
    applicationId: string,
    activeConfigRevisionId: string | null,
): Promise<Map<string, number>> {
    if (resolvedConfig != null) {
        const parsed = previewConfigSchema.safeParse(resolvedConfig);
        if (parsed.success) {
            return new Map(parsed.data.apps.map((app, index) => [app.name, index]));
        }
    }
    return loadActiveConfigAppIndexes(db, applicationId, activeConfigRevisionId);
}

async function loadActiveConfigAppIndexes(
    db: PrismaClient,
    applicationId: string,
    activeConfigRevisionId: string | null,
): Promise<Map<string, number>> {
    if (activeConfigRevisionId == null) return new Map();

    const revision = await db.previewkitConfigRevision.findFirst({
        where: { id: activeConfigRevisionId, applicationId },
        select: { document: true },
    });
    if (revision == null) return new Map();

    const parsed = previewConfigSchema.safeParse(revision.document);
    if (!parsed.success) return new Map();

    return new Map(parsed.data.apps.map((app, index) => [app.name, index]));
}

export async function writePreviewUrl(
    db: PrismaClient,
    {
        applicationId,
        organizationId,
        previewUrl,
    }: { applicationId: string; organizationId: string; previewUrl: string },
): Promise<void> {
    await db.$transaction(async (tx) => {
        const application = await tx.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                mainBranch: { select: { deploymentId: true } },
                onboardingState: { select: { step: true } },
            },
        });
        const deploymentId = application?.mainBranch?.deploymentId;
        if (deploymentId == null) throw new NotFoundError("Application has no main branch deployment");

        await tx.webDeployment.upsert({
            where: { deploymentId },
            create: {
                deploymentId,
                url: previewUrl,
                file: "",
                organizationId,
            },
            update: { url: previewUrl },
        });

        // Keep the URL fresh but never roll a finished onboarding back to
        // `preview_verified` - that would drop it out of the completed state.
        const isCompleted = application?.onboardingState?.step === "completed";
        await tx.onboardingState.update({
            where: { applicationId },
            data: {
                previewUrl,
                productionUrl: previewUrl,
                ...(isCompleted ? {} : { step: "preview_verified", previewVerificationStatus: "ready" }),
            },
        });
    });
}
