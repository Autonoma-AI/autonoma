import { type Prisma, type PrismaClient } from "@autonoma/db";
import { queryLokiLogs } from "@autonoma/diffs/analysis/logs/loki";
import {
    type DiagnosePreviewkitDeployInput,
    type PreviewDiagnosisFinding,
    previewConfigSchema,
    projectManifest,
} from "@autonoma/types";
import {
    type PreviewFailure,
    buildServiceSummaries,
    classifyPreviewFailures,
    toAppBuildOutcomeMap,
} from "../routes/deployments/preview-summary";
import { Service } from "../routes/service";
import { describeEvidenceSource, explainDeployFailure } from "./deploy-failure-explanation";
import { type DeployFreshness, deployFreshness } from "./deploy-freshness";

/** Main-branch preview environments are stored under PR number 0. */
const MAIN_BRANCH_PREVIEW_ENVIRONMENT_NUMBER = 0;
/** Loki line-filter regex used to pull just the interesting (error-shaped) log lines. */
const LOG_ERROR_REGEX = "error|fail|fatal|cannot|missing|undefined|null|panic|exception|refused|denied";
/** Per-source cap on log lines returned, to keep the tool response bounded. */
const MAX_LOG_LINES = 120;
/** How far back to look for logs when the deploy has no recorded start time. */
const LOG_LOOKBACK_MS = 60 * 60 * 1000;

const environmentSelect = {
    id: true,
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
    createdAt: true,
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

type EnvironmentRow = Prisma.PreviewkitEnvironmentGetPayload<{ select: typeof environmentSelect }>;

/**
 * Raw, deterministic diagnostic signals for a preview deploy. Returned by
 * {@link PreviewkitDiagnosisService.signals} for the MCP `diagnose_deploy` tool, whose
 * consumer is a coding agent that has the repo in front of it and can reason for itself.
 * Giving it the source signals (state, rule-based failure classification, service states,
 * config env-key surface, error-shaped logs) is more useful - and less hallucination-prone
 * - than a prose summary. The `findings` are included as a starting-point categorization
 * the agent can trust.
 */
export interface PreviewDeploySignals {
    /** "ok" = no failure detected; "failing" = at least one classified failure; "unavailable" = nothing to diagnose. */
    status: "ok" | "failing" | "unavailable";
    /** Present only when status is "unavailable" (no repo link, or no environment yet). */
    reason?: string;
    deploy?: { status: string; phase?: string; error?: string };
    services?: Array<{ name: string; status: string; error?: string; url?: string; imageTag?: string }>;
    build?: { status: string; error?: string; startedAt?: string; finishedAt?: string; durationMs?: number };
    /** Rule-based failure classification derived from the build and service states. */
    failures?: PreviewFailure[];
    /** Env-key surface + app paths/ports the config declares (never secret values). */
    config?: unknown;
    /** Error-shaped log lines (secret-masked), fetched only when the deploy is failing. */
    logs?: string[];
    /** Deterministic, rule-based findings - derived from the classified failures, safe to trust. */
    findings?: PreviewDiagnosisFinding[];
    /**
     * How far the recorded state can be trusted, from the age of the last deploy.
     * Every other signal here is what the deploy pipeline last wrote, so a healthy
     * verdict on a long-dead environment is otherwise indistinguishable from a
     * healthy verdict on a live one.
     */
    freshness?: DeployFreshness;
}

/** Resolved environment, or a reason it can't be diagnosed yet. */
type ResolvedEnvironment = { environment: EnvironmentRow } | { reason: string };

export class PreviewkitDiagnosisService extends Service {
    constructor(
        private readonly db: PrismaClient,
        /** VPC-internal Grafana Loki base URL; when absent, logs are skipped (findings still produced). */
        private readonly lokiBaseUrl?: string,
    ) {
        super();
    }

    /**
     * The raw, deterministic diagnostic signals for the MCP `diagnose_deploy` tool
     * (agent consumer): environment/build state, rule-based failure classification,
     * per-service states, the config env-key surface, error-shaped
     * logs (masked, only when failing), and the deterministic rule-based findings.
     * The client agent reasons over the source signals itself.
     */
    async signals(organizationId: string, input: DiagnosePreviewkitDeployInput): Promise<PreviewDeploySignals> {
        this.logger.info("Collecting PreviewKit deploy signals", {
            organizationId,
            applicationId: input.applicationId,
            prNumber: input.prNumber ?? MAIN_BRANCH_PREVIEW_ENVIRONMENT_NUMBER,
        });

        const resolved = await this.resolveEnvironment(organizationId, input);
        if ("reason" in resolved) return { status: "unavailable", reason: resolved.reason };
        const environment = resolved.environment;

        const failures = this.classifyFailures(environment);
        const logs = failures.length > 0 ? await this.fetchLogs(environment) : [];
        const findings = this.postProcess(heuristicFindings(failures, environment.error ?? undefined), environment);
        const latestBuild = environment.builds[0];

        this.logger.info("PreviewKit deploy signals collected", {
            applicationId: input.applicationId,
            failureCount: failures.length,
            logLines: logs.length,
        });
        return {
            status: failures.length === 0 ? "ok" : "failing",
            deploy: {
                status: environment.status,
                phase: environment.phase ?? undefined,
                error: maskMaybeSecret(environment.error),
            },
            services: environment.appInstances.map((instance) => ({
                name: instance.appName,
                status: instance.status,
                error: maskMaybeSecret(instance.error),
                url: instance.url ?? undefined,
                imageTag: instance.imageTag ?? undefined,
            })),
            build:
                latestBuild == null
                    ? undefined
                    : {
                          status: latestBuild.status,
                          error: maskMaybeSecret(latestBuild.error),
                          startedAt: latestBuild.startedAt?.toISOString(),
                          finishedAt: latestBuild.finishedAt?.toISOString(),
                          durationMs: latestBuild.durationMs ?? undefined,
                      },
            failures,
            config: summarizeConfig(environment.resolvedConfig),
            logs,
            findings,
            freshness: deployFreshness({
                status: environment.status,
                deployedAt: environment.deployedAt ?? undefined,
            }),
        };
    }

    private async resolveEnvironment(
        organizationId: string,
        input: DiagnosePreviewkitDeployInput,
    ): Promise<ResolvedEnvironment> {
        const prNumber = input.prNumber ?? MAIN_BRANCH_PREVIEW_ENVIRONMENT_NUMBER;

        const application = await this.db.application.findFirst({
            where: { id: input.applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        if (application?.githubRepositoryId == null) {
            return { reason: "Application is not linked to a GitHub repository." };
        }

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: { organizationId, githubRepositoryId: application.githubRepositoryId, prNumber },
            select: environmentSelect,
        });
        if (environment == null) return { reason: "No PreviewKit environment exists to diagnose yet." };
        return { environment };
    }

    private classifyFailures(environment: EnvironmentRow): PreviewFailure[] {
        const latestBuild = environment.builds[0] ?? null;
        const manifest = projectManifest(environment.resolvedConfig);
        const appBuilds = toAppBuildOutcomeMap(latestBuild?.appBuilds ?? []);
        const services = buildServiceSummaries({
            branchName: environment.headRef,
            environment,
            manifest,
            latestBuild,
            appBuilds,
        });
        return classifyPreviewFailures({
            appBuilds,
            services,
            environmentError: environment.error ?? latestBuild?.error ?? undefined,
            appIndexByName: this.appIndexByName(environment.resolvedConfig),
        });
    }

    private appIndexByName(resolvedConfig: Prisma.JsonValue | null): Map<string, number> {
        if (resolvedConfig == null) return new Map();
        const parsed = previewConfigSchema.safeParse(resolvedConfig);
        if (!parsed.success) return new Map();
        return new Map(parsed.data.apps.map((app, index) => [app.name, index]));
    }

    private async fetchLogs(environment: EnvironmentRow): Promise<string[]> {
        if (this.lokiBaseUrl == null) return [];

        const startMs = (environment.deployedAt ?? environment.createdAt).getTime() - LOG_LOOKBACK_MS;
        try {
            const page = await queryLokiLogs({
                lokiBaseUrl: this.lokiBaseUrl,
                namespace: environment.namespace,
                startEpoch: Math.floor(startMs / 1000),
                endEpoch: Math.floor(Date.now() / 1000),
                regex: LOG_ERROR_REGEX,
                limit: MAX_LOG_LINES,
                // What failed is often the build, so its output is evidence here rather than noise.
                includeBuildOutput: true,
            });
            return page.lines.map((entry) => maskSecretsInLine(entry.line));
        } catch (err) {
            this.logger.warn("Loki log fetch failed during diagnosis, continuing without logs", {
                namespace: environment.namespace,
                err,
            });
            return [];
        }
    }

    /** Drops findings attributed to an app the environment and the config no longer know about. */
    private postProcess(findings: PreviewDiagnosisFinding[], environment: EnvironmentRow): PreviewDiagnosisFinding[] {
        const appNames = new Set(environment.appInstances.map((instance) => instance.appName));
        for (const app of projectManifest(environment.resolvedConfig).apps ?? []) appNames.add(app.name);

        return findings.filter((finding) => finding.appName == null || appNames.has(finding.appName));
    }
}

export function heuristicFindings(failures: PreviewFailure[], environmentError?: string): PreviewDiagnosisFinding[] {
    const findings = failures.map((failure) => heuristicFinding(failure));
    if (findings.length === 0 && environmentError != null && environmentError !== "") {
        findings.push({
            category: "unknown",
            severity: "blocking",
            title: "Deploy failed",
            explanation: environmentError,
            fixSteps: ["Review the build logs for the underlying error, then redeploy."],
            action: "redeploy",
            confidence: "low",
            evidence: [environmentError],
        });
    }
    return findings;
}

function heuristicFinding(failure: PreviewFailure): PreviewDiagnosisFinding {
    const base = {
        title: failure.message.slice(0, 120),
        explanation: failure.message,
        evidence: [failure.message],
        ...(failure.appName != null ? { appName: failure.appName } : {}),
        ...(failure.fieldPath != null ? { fieldPath: failure.fieldPath } : {}),
    };

    if (failure.code === "missing_path") {
        return {
            ...base,
            category: "user_setup",
            severity: "blocking",
            title: "App path not found in the repository",
            fixSteps: ["Set the app's path to the directory that contains its code.", "Redeploy after saving."],
            action: "edit_config",
            confidence: "high",
        };
    }
    if (failure.code === "missing_dockerfile") {
        return {
            ...base,
            category: "user_setup",
            severity: "blocking",
            title: "Dockerfile not found at the configured path",
            fixSteps: ["Point the Dockerfile field at an existing Dockerfile, or clear it to auto-detect the build."],
            action: "edit_config",
            confidence: "high",
        };
    }
    if (failure.code === "missing_image") {
        return {
            ...base,
            category: "user_setup",
            severity: "blocking",
            title: "No image was built for this app",
            fixSteps: ["Check the build logs for the failing step, fix the build config, then redeploy."],
            action: "redeploy",
            confidence: "medium",
        };
    }
    // A rollout that got far enough to name a terminal pod reason is explainable, and the
    // generic fallback below is actively wrong for it: a crashlooping container's cause is in
    // its own runtime logs, never in the build output the fallback points at.
    //
    // Gated on the code the same way `buildServiceSummaries` gates it, so the agent and the UI
    // cannot come to different conclusions about one failure. A build error is the build's own
    // output and needs no translation; without this gate, a build message that happened to
    // contain a reason substring would be explained here and not there.
    const explanation = failure.code === "build_failed" ? undefined : explainDeployFailure(failure.message);
    if (explanation != null) {
        return {
            ...base,
            category: "user_setup",
            severity: "blocking",
            title: explanation.title,
            explanation: explanation.explanation,
            fixSteps: [describeEvidenceSource(explanation.lookIn), "Fix the cause, then redeploy."],
            action: "redeploy",
            confidence: "medium",
        };
    }

    return {
        ...base,
        category: failure.code === "unknown" ? "unknown" : "user_setup",
        severity: "blocking",
        title: failure.code === "build_failed" ? "Build failed" : "Deploy failed",
        fixSteps: ["Review the build logs for the underlying error, fix it, then redeploy."],
        action: "redeploy",
        confidence: "low",
    };
}

/** Projects the manifest subset the agent needs from a resolved config, without secret values. */
function summarizeConfig(resolvedConfig: Prisma.JsonValue | null): unknown {
    const parsed = resolvedConfig == null ? undefined : previewConfigSchema.safeParse(resolvedConfig);
    if (parsed == null || !parsed.success) return {};
    return {
        apps: parsed.data.apps.map((app) => ({
            name: app.name,
            path: app.path,
            dockerfile: app.dockerfile,
            port: app.port,
            // Env-var keys the document declares: topology connections + build-time
            // secret keys. Runtime secret values live in AWS, never in the config.
            envKeys: [...app.connections.map((connection) => connection.key), ...app.build_secrets],
        })),
        services: parsed.data.services.map((service) => ({ name: service.name, recipe: service.recipe })),
    };
}

/** Masks a nullable error string before it leaves the API; `undefined` when absent so the key is omitted. */
function maskMaybeSecret(value: string | null | undefined): string | undefined {
    return value == null || value === "" ? undefined : maskSecretsInLine(value);
}

/** Masks secret-shaped tokens (long high-entropy strings, credentialed URLs) in a log line before it leaves the API. */
export function maskSecretsInLine(line: string): string {
    return line
        .replace(/([a-z][a-z0-9+.-]*:\/\/[^:@\s]+):[^@\s]+@/gi, "$1:***@")
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***");
}
