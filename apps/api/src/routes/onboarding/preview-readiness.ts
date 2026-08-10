import {
    type OnboardingPreviewEnvironmentMode,
    type OnboardingPreviewVerificationStatus,
    type OnboardingStep,
    type Prisma,
    type PrismaClient,
} from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { WorkloadLiveness } from "@autonoma/k8s/preview-liveness";
import { parseStringRecord, previewConfigSchema, projectManifest, resolvePrimaryUrl } from "@autonoma/types";
import { applicationBranchRefs } from "../../github/application-branch-refs";
import {
    buildServiceSummaries,
    classifyPreviewFailures,
    derivePreviewStatus,
    isBuildingOverPriorAttempt,
    toAppBuildOutcomeMap,
    type PreviewFailure,
} from "../deployments/preview-summary";
import { resolvePreviewLivenessService } from "../preview-access/resolve-preview-liveness";
import { OnboardingAnalytics } from "./onboarding-analytics";
import { isStepAtOrPast } from "./onboarding-step-order";

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
    /**
     * What this service is, which decides how its status reads. An `app` is built
     * from the repo and deployed as its own pod; a `managed` service is a recipe
     * (postgres, redis, ...) the environment provisions, so "building" there means
     * the environment is bringing it up, not that anything is being compiled.
     */
    kind: "app" | "managed";
    /**
     * `idle` only ever comes from the cluster: the workload is deployed and healthy
     * but scaled to zero by the Gatekeeper idle loop. It is not a failure and not a
     * build state - it is a preview asleep, which the next request wakes.
     */
    status: "ready" | "building" | "failed" | "idle" | "unknown";
    /**
     * Where `status` came from. `pipeline` is the deploy's own verdict - it says a
     * workload was successfully handed to Kubernetes, not that it is up. `cluster`
     * is the live readiness of the running workload, the same signal the preview
     * link and the Gatekeeper act on, so it can see a service that deployed cleanly
     * and then crashlooped.
     */
    statusSource: "pipeline" | "cluster";
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
    // The Kubernetes namespace, which is how the cluster's live workload state is
    // keyed - it is what turns "the deploy succeeded" into "the service is up".
    namespace: true,
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
    primaryUrl?: string;
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
    // `acceptedAt` reading) and, worse, would roll an onboarding that already
    // advanced past `preview_verified` (`diff_trigger`/`completed`) back down.
    // Still re-persist when the app sits at `preview_verified` with a non-ready
    // status, so a stale status recovers to `ready`.
    const alreadyAtOrPastVerified =
        isStepAtOrPast(step, "preview_verified") &&
        (step !== "preview_verified" || previewVerificationStatus === "ready");
    if (!alreadyAtOrPastVerified) {
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
            previewDeployRef: true,
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
    const buildingOverPriorAttempt = isBuildingOverPriorAttempt(environment.status, latestBuild);
    const effectiveLatestBuild = buildingOverPriorAttempt ? null : latestBuild;
    const manifest = projectManifest(environment.resolvedConfig);
    const urls = parseStringRecord(environment.urls);
    const primaryUrl = resolvePrimaryUrl(manifest, urls);
    const appBuilds = toAppBuildOutcomeMap(effectiveLatestBuild?.appBuilds ?? []);
    const derivedServices = buildServiceSummaries({
        // The ref the environment actually built is the honest label; it differs from
        // the trunk whenever the base preview is pointed at an integration branch.
        branchName: environment.headRef ?? application.mainBranch?.name,
        environment,
        manifest,
        latestBuild: effectiveLatestBuild,
        appBuilds,
    });
    // A stale `build_failed` app-instance row can survive into the first moments
    // of a redeploy; while building over a prior attempt, present it as still
    // building rather than as a leftover failure - and count it that way too.
    const services = buildingOverPriorAttempt
        ? derivedServices.map((service) =>
              service.status === "failed" ? { ...service, status: "building" as const, statusReason: null } : service,
          )
        : derivedServices;
    const failedServiceCount = services.filter((service) => service.status === "failed").length;
    const degradedServiceCount = services.filter((service) => service.status === "fallback").length;
    // Drift is "the trunk moved past what we deployed", which only means anything
    // while the base preview tracks the trunk. Pointed at an integration branch, the
    // environment's own head IS the current head, so it can never read as stale.
    const trackedHeadSha = applicationBranchRefs(application).deployTracksTrunk
        ? (application.mainBranch?.activeSnapshot?.headSha ?? environment.headSha)
        : environment.headSha;
    const previewStatus = derivePreviewStatus({
        previewkitStatus: environment.status,
        currentHeadSha: trackedHeadSha,
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
    // Two independent reads - one against our own database, one against the preview
    // cluster - on a query the onboarding screen polls every few seconds.
    const [appIndexByName, liveness] = await Promise.all([
        resolveFailureAppIndexes(db, environment.resolvedConfig, applicationId),
        readWorkloadLiveness(environment.namespace),
    ]);
    const failures = buildingOverPriorAttempt
        ? []
        : classifyPreviewFailures({
              appBuilds,
              services,
              environmentError: environment.error ?? latestBuild?.error ?? undefined,
              appIndexByName,
          });
    const diagnostics = diagnosticsFromPreviewStatus({
        status: previewStatus,
        phase: environment.phase ?? undefined,
        error: buildingOverPriorAttempt ? undefined : (environment.error ?? latestBuild?.error ?? undefined),
        primaryUrl,
        logs,
        failures,
    });

    if (diagnostics.status === "ready" && primaryUrl != null) {
        // writePreviewUrl is itself guarded against downgrading a completed row.
        const write = await writePreviewUrl(db, { applicationId, organizationId, previewUrl: primaryUrl });
        // The Autonoma-hosted path reaches `preview_verified` here, inside a polled
        // query that no tracker wraps - so the funnel's central conversion would be
        // missing for every PreviewKit customer without this. It costs a read only
        // on the poll that actually flips the step, not on the ones before it.
        if (write.advancedToVerified) {
            await new OnboardingAnalytics(db).stepAdvanced(
                { distinctId: organizationId, organizationId, applicationId },
                "previewkit_deploy_ready",
                "system",
                write.fromStep,
            );
        }
    } else if (!isCompleted && shouldPersistPreviewVerificationStatus(step, previousStatus, diagnostics.status)) {
        // Keep the verification status accurate, but only roll the *step* back to
        // `previewkit_deploying` while the app is still in the deploy phase. An app
        // that already reached `preview_verified` must not be demoted by a transient
        // rebuild - a previewkit app only re-advances while the onboarding page is
        // polling readiness, so a demotion strands it short of `completed`.
        const stillInDeployPhase = !isStepAtOrPast(step, "preview_verified");
        await db.onboardingState.update({
            where: { applicationId },
            data: {
                previewVerificationStatus: diagnostics.status,
                ...(diagnostics.status === "building" && stillInDeployPhase ? { step: "previewkit_deploying" } : {}),
            },
        });
    }

    return {
        mode: "previewkit",
        ...(primaryUrl != null ? { previewUrl: primaryUrl } : {}),
        diagnostics,
        services: services.map((service) => {
            // `logAvailability` already carries the distinction: only an app is built
            // from the PR, so only an app has build output. Deriving from it keeps the
            // two views of "is this ours to build?" from drifting apart.
            const kind = service.logAvailability === "build_and_runtime" ? ("app" as const) : ("managed" as const);
            const pipelineStatus = toReadinessServiceStatus(service.status);
            const live = liveness.get(service.name);
            const resolved = resolveServiceStatus(pipelineStatus, live);
            const error = resolved.error ?? service.statusReason ?? undefined;
            return {
                name: service.name,
                kind,
                status: resolved.status,
                statusSource: resolved.statusSource,
                ...(service.endpoint != null ? { url: service.endpoint } : {}),
                ...(service.port != null ? { port: service.port } : {}),
                ...(error != null ? { error } : {}),
            };
        }),
    };
}

/**
 * The live per-workload state of one preview namespace, keyed by workload name.
 *
 * The names line up with the config by construction: the deployer names an app's
 * Deployment after the app and a recipe's StatefulSet after the service
 * (`postgres-recipe.ts` builds it as `config.name`), so "db" here is the same "db"
 * the user configured.
 *
 * Best effort by design. Liveness needs cross-cluster reach that not every
 * deployment has, and a read failure already degrades to the last snapshot inside
 * the service - so an empty map simply leaves every service on the pipeline's own
 * verdict, exactly as before. A liveness outage must never fail the onboarding poll.
 */
async function readWorkloadLiveness(namespace: string): Promise<Map<string, WorkloadLiveness>> {
    const service = resolvePreviewLivenessService();
    if (service == null) return new Map();

    const fleet = await service.getFleet();
    const workloads = fleet.get(namespace)?.workloads ?? [];
    return new Map(workloads.map((workload) => [workload.name, workload]));
}

/**
 * One service's reported status, preferring what the cluster can see over what the
 * deploy claimed.
 *
 * These answer different questions. The pipeline's verdict means "the deploy step
 * for this workload succeeded", which is true forever after it happens - it cannot
 * see a database that accepted its manifest and then crashlooped on startup, and it
 * is why a preview could read all-green while nothing served a request. The cluster
 * reads the workload's actual replica readiness, the same signal the preview link
 * and the Gatekeeper act on.
 *
 * The cluster only wins where it has something to say. Mid-deploy the workload does
 * not exist yet, so there is no entry and the pipeline's "building" stands - which
 * is right, and is why this is an overlay rather than a replacement.
 */
export function resolveServiceStatus(
    pipelineStatus: PreviewReadinessService["status"],
    live: WorkloadLiveness | undefined,
): {
    status: PreviewReadinessService["status"];
    statusSource: PreviewReadinessService["statusSource"];
    error?: string;
} {
    if (live == null) return { status: pipelineStatus, statusSource: "pipeline" };
    if (live.state === "healthy") return { status: "ready", statusSource: "cluster" };
    if (live.state === "waking") return { status: "building", statusSource: "cluster" };
    if (live.state === "asleep") return { status: "idle", statusSource: "cluster" };
    // The Kubernetes reason (CrashLoopBackOff, ImagePullBackOff, ...) is the whole
    // value of asking the cluster: it names what a green deploy could not tell you.
    return {
        status: "failed",
        statusSource: "cluster",
        error: live.reason ?? "The workload is not staying up.",
    };
}

/**
 * App-name -> index map used to point structured failures at
 * `apps.<i>.<field>` paths. Prefers the environment's resolved (merged)
 * config snapshot - it covers dependency-repo apps too, which the primary
 * config alone does not - and falls back to the Application's saved config.
 * The UI deep-links via app name plus the path's field segment, so an index
 * from the merged document is sufficient. Best-effort: when neither parses,
 * the map is empty and failures carry no fieldPath.
 */
async function resolveFailureAppIndexes(
    db: PrismaClient,
    resolvedConfig: Prisma.JsonValue | null,
    applicationId: string,
): Promise<Map<string, number>> {
    if (resolvedConfig != null) {
        const parsed = previewConfigSchema.safeParse(resolvedConfig);
        if (parsed.success) {
            return new Map(parsed.data.apps.map((app, index) => [app.name, index]));
        }
    }
    return loadSavedConfigAppIndexes(db, applicationId);
}

async function loadSavedConfigAppIndexes(db: PrismaClient, applicationId: string): Promise<Map<string, number>> {
    const stored = await db.previewkitConfig.findUnique({
        where: { applicationId },
        select: { document: true },
    });
    if (stored == null) return new Map();

    const parsed = previewConfigSchema.safeParse(stored.document);
    if (!parsed.success) return new Map();

    return new Map(parsed.data.apps.map((app, index) => [app.name, index]));
}

/**
 * What a {@link writePreviewUrl} call did to the onboarding step.
 *
 * Returned rather than reported from in here because this is the one place that
 * stamps `preview_verified` - the funnel's central conversion - and it is
 * reached three ways, only one of which (a tRPC mutation) the analytics
 * middleware observes. Handing the fact back lets the other two report it
 * without re-deriving the "did it advance?" condition, which would then have two
 * copies to keep in step.
 */
export interface PreviewUrlWriteResult {
    /** The onboarding step as it was before the write. */
    fromStep: OnboardingStep;
    /** True when THIS write is what stamped `preview_verified`. */
    advancedToVerified: boolean;
}

export async function writePreviewUrl(
    db: PrismaClient,
    {
        applicationId,
        organizationId,
        previewUrl,
    }: { applicationId: string; organizationId: string; previewUrl: string },
): Promise<PreviewUrlWriteResult> {
    return db.$transaction(async (tx) => {
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
                organizationId,
            },
            update: { url: previewUrl },
        });

        // Keep the URL fresh but never roll an onboarding that already reached
        // `preview_verified` back down - a signal firing for a `diff_trigger` (or
        // `completed`) app must not demote it to `preview_verified` and strand it
        // short of go-live. Only stamp the verified transition when still before it.
        const step = application?.onboardingState?.step ?? "github";
        const alreadyAtOrPastVerified = isStepAtOrPast(step, "preview_verified");
        await tx.onboardingState.update({
            where: { applicationId },
            data: {
                previewUrl,
                productionUrl: previewUrl,
                ...(alreadyAtOrPastVerified ? {} : { step: "preview_verified", previewVerificationStatus: "ready" }),
            },
        });

        return { fromStep: step, advancedToVerified: !alreadyAtOrPastVerified };
    });
}
