import { type Prisma, type PrismaClient } from "@autonoma/db";
import { queryLokiLogs } from "@autonoma/investigation/logs";
import {
    type AiDiagnosisResult,
    AiDiagnosisResultSchema,
    type DiagnosePreviewkitDeployInput,
    type DiagnosePreviewkitDeployResult,
    type PreviewDiagnosisFinding,
    type SuggestedEnvVar,
    detectSensitive,
    previewConfigSchema,
} from "@autonoma/types";
import { type LanguageModel, generateObject } from "ai";
import {
    type PreviewFailure,
    buildServiceSummaries,
    classifyPreviewFailures,
    projectManifest,
    toAppBuildOutcomeMap,
} from "../routes/deployments/preview-summary";
import { Service } from "../routes/service";

/** Main-branch preview environments are stored under PR number 0. */
const MAIN_BRANCH_PREVIEW_ENVIRONMENT_NUMBER = 0;
/** Loki line-filter regex used to pull just the interesting (error-shaped) log lines. */
const LOG_ERROR_REGEX = "error|fail|fatal|cannot|missing|undefined|null|panic|exception|refused|denied";
/** Per-source cap on log lines fed to the model, to keep the prompt bounded. */
const MAX_LOG_LINES = 120;
/** How far back to look for logs when the deploy has no recorded start time. */
const LOG_LOOKBACK_MS = 60 * 60 * 1000;
/** Cap on fix steps kept per finding, so a runaway model response stays bounded. */
const MAX_FIX_STEPS = 6;
/** Low thinking budget - diagnosis is bounded classification, not open-ended reasoning. */
const GEMINI_PROVIDER_OPTIONS = { google: { thinkingConfig: { thinkingLevel: "low" } } };
/** Wall-clock cap for a single diagnosis generation request. */
const AI_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
/** Transient-failure retries the AI SDK performs before we fall back to heuristics. */
const AI_MAX_RETRIES = 3;

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

type EnvironmentRow = Prisma.PreviewkitEnvironmentGetPayload<{ select: typeof environmentSelect }>;

const DIAGNOSIS_SYSTEM_PROMPT = `You are a preview-infrastructure diagnostician for PreviewKit. Given a failed deploy's status, structured failures, service and addon states, the resolved deploy config, and recent build/runtime log lines, produce a short summary and a list of findings that explain what went wrong and how to fix it.

Classify each finding into exactly one category:
- "missing_env_var": a required environment variable or secret is absent or empty (the app crashes referencing it, or config resolution fails on an unset value). User-fixable.
- "user_setup": the customer's config is wrong - a bad app path, missing/incorrect Dockerfile, wrong port, failing health check, unbuildable image, or a mis-provisioned addon they configured. User-fixable.
- "autonoma_error": a PreviewKit/platform fault the customer cannot fix - Kubernetes API errors, External-Secret sync timeouts, namespace or generated-spec problems, buildkit infrastructure failures, or our internal timeouts.
- "unknown": the signals do not clearly attribute the failure.

Rules:
- Write "explanation" in plain language a non-expert can act on. Keep "fixSteps" concrete and short.
- Set "appName" and, when you can, "fieldPath" (e.g. "apps.0.dockerfile") so the UI can deep-link the exact config input.
- For "missing_env_var", populate "suggestedEnv" with the exact variable keys. Set "reference" to a "{{service.url}}"-style token when it wires to a managed service, otherwise a literal "value" only when you are confident. Mark credentials sensitive=true.
- Set "action" to the single best follow-up: "edit_config", "edit_secrets", "redeploy", or "contact_support" (use contact_support for autonoma_error).
- Cite the concrete log line, error string, or config field in "evidence". Never invent findings without support.
- Prefer "autonoma_error" only when the signal clearly points at our infrastructure, not the customer's application code or config.`;

export class PreviewkitDiagnosisService extends Service {
    constructor(
        private readonly db: PrismaClient,
        /** VPC-internal Grafana Loki base URL; when absent, logs are skipped (findings still produced). */
        private readonly lokiBaseUrl?: string,
        /** Model for the enrichment pass; when absent (e.g. tests) the AI pass is skipped and heuristics stand alone. */
        private readonly model?: LanguageModel,
    ) {
        super();
    }

    async diagnose(
        organizationId: string,
        input: DiagnosePreviewkitDeployInput,
    ): Promise<DiagnosePreviewkitDeployResult> {
        this.logger.info("Diagnosing PreviewKit deploy", {
            organizationId,
            applicationId: input.applicationId,
        });

        const application = await this.db.application.findFirst({
            where: { id: input.applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        if (application?.githubRepositoryId == null) {
            return { status: "unavailable", reason: "Application is not linked to a GitHub repository.", findings: [] };
        }

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: {
                organizationId,
                githubRepositoryId: application.githubRepositoryId,
                prNumber: MAIN_BRANCH_PREVIEW_ENVIRONMENT_NUMBER,
            },
            select: environmentSelect,
        });
        if (environment == null) {
            return { status: "unavailable", reason: "No PreviewKit environment exists to diagnose yet.", findings: [] };
        }

        const failures = this.classifyFailures(environment);
        const logs = await this.fetchLogs(environment);
        this.logger.info("Collected diagnosis signals", {
            applicationId: input.applicationId,
            failureCount: failures.length,
            logLines: logs.length,
        });

        const enriched = await this.enrich(environment, failures, logs);
        const findings = this.postProcess(enriched.findings, environment);
        this.logger.info("PreviewKit diagnosis ready", {
            applicationId: input.applicationId,
            findingCount: findings.length,
        });
        return { status: "ok", summary: enriched.summary, findings };
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
            const lines = await queryLokiLogs({
                lokiBaseUrl: this.lokiBaseUrl,
                namespace: environment.namespace,
                startEpoch: Math.floor(startMs / 1000),
                endEpoch: Math.floor(Date.now() / 1000),
                regex: LOG_ERROR_REGEX,
                limit: MAX_LOG_LINES,
            });
            return lines.map(maskSecretsInLine);
        } catch (err) {
            this.logger.warn("Loki log fetch failed during diagnosis, continuing without logs", {
                namespace: environment.namespace,
                err,
            });
            return [];
        }
    }

    private async enrich(
        environment: EnvironmentRow,
        failures: PreviewFailure[],
        logs: string[],
    ): Promise<AiDiagnosisResult> {
        const heuristic = heuristicFindings(failures, environment.error ?? undefined);
        if (this.model == null) return heuristic;

        try {
            const { object } = await generateObject({
                model: this.model,
                system: DIAGNOSIS_SYSTEM_PROMPT,
                schema: AiDiagnosisResultSchema,
                prompt: JSON.stringify({
                    diagnostics: {
                        status: environment.status,
                        phase: environment.phase,
                        error: maskMaybeSecret(environment.error),
                    },
                    failures: failures.map((failure) => ({ ...failure, message: maskSecretsInLine(failure.message) })),
                    services: this.serviceStates(environment),
                    addons: environment.addons.map((addon) => ({
                        name: addon.name,
                        provider: addon.provider,
                        status: addon.status,
                        error: maskMaybeSecret(addon.error),
                    })),
                    resolvedConfig: summarizeConfig(environment.resolvedConfig),
                    logs,
                }),
                providerOptions: GEMINI_PROVIDER_OPTIONS,
                maxRetries: AI_MAX_RETRIES,
                timeout: AI_REQUEST_TIMEOUT_MS,
                experimental_telemetry: { isEnabled: true },
            });
            return object.findings.length > 0 ? object : heuristic;
        } catch (err) {
            this.logger.warn("AI diagnosis enrichment failed, using heuristics", { err });
            return heuristic;
        }
    }

    private serviceStates(environment: EnvironmentRow): Array<{ name: string; status: string; error?: string }> {
        return environment.appInstances.map((instance) => ({
            name: instance.appName,
            status: instance.status,
            ...(instance.error != null ? { error: maskSecretsInLine(instance.error) } : {}),
        }));
    }

    private postProcess(findings: PreviewDiagnosisFinding[], environment: EnvironmentRow): PreviewDiagnosisFinding[] {
        const appNames = new Set(environment.appInstances.map((instance) => instance.appName));
        for (const app of projectManifest(environment.resolvedConfig).apps ?? []) appNames.add(app.name);

        return findings
            .filter((finding) => finding.appName == null || appNames.has(finding.appName))
            .map((finding) => {
                const fixSteps = finding.fixSteps.slice(0, MAX_FIX_STEPS);
                if (finding.category !== "missing_env_var") return { ...finding, fixSteps };
                const suggestedEnv = ensureSuggestedEnv(finding);
                return { ...finding, fixSteps, suggestedEnv };
            });
    }
}

export function heuristicFindings(failures: PreviewFailure[], environmentError?: string): AiDiagnosisResult {
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
    const summary =
        findings.length === 0
            ? "No specific failure was detected."
            : `Detected ${findings.length} issue${findings.length === 1 ? "" : "s"} with this deploy.`;
    return { summary, findings };
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
    if (failure.code === "addon_failed") {
        return {
            ...base,
            category: "autonoma_error",
            severity: "blocking",
            title: "An addon failed to provision",
            fixSteps: ["Retry the deploy.", "If it keeps failing, contact Autonoma support with these details."],
            action: "contact_support",
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

/** Guarantees a `missing_env_var` finding has at least one applyable env var. */
function ensureSuggestedEnv(finding: PreviewDiagnosisFinding): SuggestedEnvVar[] {
    if (finding.suggestedEnv != null && finding.suggestedEnv.length > 0) return finding.suggestedEnv;
    const key = envKeyFromText(finding.title) ?? envKeyFromText(finding.explanation);
    if (key == null) return [];
    return [
        {
            key,
            sensitive: detectSensitive(key, "").sensitive,
            confidence: finding.confidence,
            evidence: finding.evidence,
        },
    ];
}

/** Best-effort extraction of an ENV_VAR-shaped token from a message. */
function envKeyFromText(text: string): string | undefined {
    const match = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(text);
    return match?.[1];
}

/** Projects the manifest subset the model needs from a resolved config, without secret values. */
function summarizeConfig(resolvedConfig: Prisma.JsonValue | null): unknown {
    const parsed = resolvedConfig == null ? undefined : previewConfigSchema.safeParse(resolvedConfig);
    if (parsed == null || !parsed.success) return {};
    return {
        apps: parsed.data.apps.map((app) => ({
            name: app.name,
            path: app.path,
            dockerfile: app.dockerfile,
            port: app.port,
            healthCheck: app.health_check,
            // Env-var keys the document declares: topology connections + build-time
            // secret keys. Runtime secret values live in AWS, never in the config.
            envKeys: [...app.connections.map((connection) => connection.key), ...app.build_secrets],
        })),
        services: parsed.data.services.map((service) => ({ name: service.name, recipe: service.recipe })),
        addons: parsed.data.addons.map((addon) => ({ name: addon.name, provider: addon.provider })),
    };
}

/** Masks a nullable error string before it reaches the model; `undefined` when absent so the key is omitted. */
function maskMaybeSecret(value: string | null | undefined): string | undefined {
    return value == null || value === "" ? undefined : maskSecretsInLine(value);
}

/** Masks secret-shaped tokens (long high-entropy strings, credentialed URLs) in a log line before it reaches the model. */
export function maskSecretsInLine(line: string): string {
    return line
        .replace(/([a-z][a-z0-9+.-]*:\/\/[^:@\s]+):[^@\s]+@/gi, "$1:***@")
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***");
}
