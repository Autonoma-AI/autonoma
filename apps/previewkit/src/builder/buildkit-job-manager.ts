import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import type { Logger } from "@autonoma/logger";
import { ApiException } from "@kubernetes/client-node";
import type * as k8s from "@kubernetes/client-node";
import { isNotFound } from "../deployer/k8s-errors";
import { logger as rootLogger } from "../logger";
import { BuildAbortedError, BuildError } from "./builder";
import { BUILD_MESSAGES } from "./messages";

const NAME_PREFIX = "buildkit";
const LABEL_MANAGED_BY = "previewkit.dev/managed-by";
const LABEL_TYPE = "previewkit.dev/type";
const LABEL_BUILD_ID = "previewkit.dev/build-id";
const LABEL_REPO = "previewkit.dev/repo";
const LABEL_PR = "previewkit.dev/pr";
const LABEL_APP = "previewkit.dev/app";
const LABEL_NAMESPACE = "previewkit.dev/namespace";
const LABEL_VALUE_MAX = 63;
const BUILDKIT_PORT = 1234;
const BUILD_ID_BYTES = 8;
const BUILD_NODE_POOL = "buildkit";
const BUILDKITD_CONFIG_CONFIGMAP = "buildkitd-ephemeral-config";
const BUILDKITD_CONFIG_VOLUME = "buildkitd-config";
const BUILDKITD_CONFIG_MOUNT_PATH = "/etc/buildkit";
const BUILDKITD_CONFIG_FILE = "/etc/buildkit/buildkitd.toml";
const BUILDKITD_CACHE_VOLUME = "cache";
const BUILDKITD_CACHE_MOUNT_PATH = "/var/lib/buildkit";
const READINESS_POLL_INTERVAL_MS = 2_000;
const DEFAULT_PROVISION_TIMEOUT_MS = 600_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 180_000;
const DIAL_TIMEOUT_MS = 2_000;
const DIAL_RETRY_BUDGET_MS = 30_000;
const DIAL_RETRY_INTERVAL_MS = 500;
const TTL_SECONDS_AFTER_FINISHED = 3600;
const MAX_DIAGNOSTIC_EVENTS = 5;
const EVENT_MESSAGE_MAX_CHARS = 300;

interface BuildJobsApi {
    createNamespacedJob(params: { namespace: string; body: k8s.V1Job }): Promise<k8s.V1Job>;
    deleteNamespacedJob(params: { name: string; namespace: string; propagationPolicy?: string }): Promise<unknown>;
}

interface BuildPodsApi {
    listNamespacedPod(params: { namespace: string; labelSelector?: string }): Promise<{ items: k8s.V1Pod[] }>;
    listNamespacedEvent(params: { namespace: string; fieldSelector?: string }): Promise<{ items: k8s.CoreV1Event[] }>;
}

/**
 * Deploy identity stamped onto the ephemeral buildkit Job/pod as labels. Every
 * field is optional and best-effort: a missing or unlabelable value is simply
 * dropped, never a reason to fail the build. The point is `kubectl -n buildkit
 * get pods -l previewkit.dev/pr=42` returning the build pod for a given PR -
 * the pod otherwise carries only a random build-id with no deploy context.
 */
export interface BuildJobIdentity {
    appName?: string;
    /** Preview namespace, e.g. `preview-acme-bank-pr-42`. */
    namespace?: string;
    /** `owner/repo` full name, e.g. `acme/bank`. */
    repo?: string;
    pr?: number;
}

interface BuildKitJobManagerOptions {
    batchApi: BuildJobsApi;
    podsApi: BuildPodsApi;
    namespace: string;
    image: string;
    activeDeadlineSeconds: number;
    provisionTimeoutMs?: number;
    startupTimeoutMs?: number;
    dial?: (host: string, port: number, timeoutMs: number) => Promise<void>;
}

interface BuildKitInstance {
    name: string;
    host: string;
}

/**
 * Creates one isolated buildkitd Job for each app-build attempt. The runner
 * waits for that Job's pod to become Ready, dials its pod IP directly, and
 * deletes the Job when the attempt finishes. The Job deadline and TTL provide
 * cleanup backstops if the runner exits before its finally block runs.
 */
export class BuildKitJobManager {
    private readonly logger: Logger;
    private readonly dial: (host: string, port: number, timeoutMs: number) => Promise<void>;
    private readonly activeJobNames = new Set<string>();

    constructor(private readonly options: BuildKitJobManagerOptions) {
        this.logger = rootLogger.child({ name: this.constructor.name });
        this.dial = options.dial ?? tryConnect;
    }

    async provision(signal?: AbortSignal, identity: BuildJobIdentity = {}): Promise<BuildKitInstance> {
        const startedAt = Date.now();
        const buildId = randomBytes(BUILD_ID_BYTES).toString("hex");
        const name = `${NAME_PREFIX}-${buildId}`;
        const namespace = this.options.namespace;
        this.logger.info("Provisioning buildkit Job", {
            extra: { name, namespace, app: identity.appName, previewNamespace: identity.namespace },
        });
        this.activeJobNames.add(name);

        try {
            throwIfAborted(signal);
            await this.options.batchApi.createNamespacedJob({
                namespace,
                body: this.jobSpec(name, buildId, identity),
            });
            const pod = await this.waitForReady(buildId, signal);
            const host = await this.waitForTcpReachable(pod, signal);
            this.logger.info("Buildkit Job ready", { extra: { name, host, elapsedMs: Date.now() - startedAt } });
            return { name, host };
        } catch (err) {
            await this.release({ name }).catch((cleanupErr: unknown) => {
                const cleanupError = cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr));
                this.logger.error("Failed to clean up buildkit Job after provisioning failed", cleanupError, {
                    extra: { name },
                });
            });
            if (signal?.aborted === true) {
                this.logger.info("Buildkit Job provisioning aborted", { extra: { name } });
                if (!(err instanceof BuildAbortedError)) {
                    throw new BuildAbortedError("Buildkit provisioning aborted (build cancelled)", { cause: err });
                }
                throw err;
            }
            const provisionError = toProvisionBuildError(err);
            this.logger.error("Failed to provision buildkit Job", provisionError, { extra: { name } });
            throw provisionError;
        }
    }

    async release(instance: { name: string }): Promise<void> {
        const namespace = this.options.namespace;
        this.logger.info("Releasing buildkit Job", { extra: { name: instance.name, namespace } });

        try {
            await this.options.batchApi.deleteNamespacedJob({
                name: instance.name,
                namespace,
                propagationPolicy: "Background",
            });
        } catch (err) {
            if (isNotFound(err)) {
                this.activeJobNames.delete(instance.name);
                this.logger.debug("Buildkit Job was already released", {
                    extra: { name: instance.name, namespace },
                });
                return;
            }
            const releaseError = err instanceof Error ? err : new Error(String(err));
            this.logger.error("Failed to release buildkit Job", releaseError, {
                extra: { name: instance.name, namespace },
            });
            throw err;
        }

        this.activeJobNames.delete(instance.name);
        this.logger.info("Released buildkit Job", { extra: { name: instance.name, namespace } });
    }

    async releaseAll(): Promise<void> {
        const names = [...this.activeJobNames];
        this.logger.info("Releasing all active buildkit Jobs", { extra: { count: names.length } });
        const results = await Promise.allSettled(names.map(async (name) => await this.release({ name })));
        const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (errors.length > 0) {
            throw new AggregateError(errors, `Failed to release ${errors.length} active buildkit Job(s)`);
        }
        this.logger.info("Released all active buildkit Jobs", { extra: { count: names.length } });
    }

    private async waitForReady(buildId: string, signal?: AbortSignal): Promise<k8s.V1Pod> {
        await this.waitForScheduled(buildId, signal);
        return await this.waitForStarted(buildId, signal);
    }

    private async waitForScheduled(buildId: string, signal?: AbortSignal): Promise<void> {
        const start = Date.now();
        const provisionTimeoutMs = this.options.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
        let lastPod: k8s.V1Pod | undefined;
        let lastState: string | undefined;

        while (Date.now() - start < provisionTimeoutMs) {
            throwIfAborted(signal);
            const pod = await this.readBuildPod(buildId);
            if (pod != null) {
                lastPod = pod;
                lastState = this.logPodStateChange({ buildId, phase: "provisioning", pod, lastState, start });
                throwForPodFailure(pod);
                if (isScheduled(pod)) {
                    this.logger.info("Buildkit Job scheduled onto a node", {
                        extra: { buildId, node: pod.spec?.nodeName, provisioningMs: Date.now() - start },
                    });
                    return;
                }
            }
            await waitForPoll(signal);
        }

        const elapsedMs = Date.now() - start;
        const diagnostics = await this.collectTimeoutDiagnostics(buildId, lastPod);
        this.logger.warn("Buildkit Job provisioning timed out", {
            extra: { buildId, phase: "provisioning", elapsedMs, diagnostics },
        });
        throw createBuildInfrastructureError(
            `Timed out after ${provisionTimeoutMs}ms waiting for buildkit Job (build-id=${buildId}) to be scheduled onto a node. ${diagnostics}`,
            { isTransient: true, userFacingMessage: BUILD_MESSAGES.capacityUnavailable },
        );
    }

    private async waitForStarted(buildId: string, signal?: AbortSignal): Promise<k8s.V1Pod> {
        const start = Date.now();
        const startupTimeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
        let lastPod: k8s.V1Pod | undefined;
        let lastState: string | undefined;

        while (Date.now() - start < startupTimeoutMs) {
            throwIfAborted(signal);
            const pod = await this.readBuildPod(buildId);
            if (pod != null) {
                lastPod = pod;
                lastState = this.logPodStateChange({ buildId, phase: "startup", pod, lastState, start });
                throwForPodFailure(pod);
                if (isReady(pod) && pod.status?.podIP != null) {
                    this.logger.info("Buildkit pod became Ready", {
                        extra: { buildId, node: pod.spec?.nodeName, startupMs: Date.now() - start },
                    });
                    return pod;
                }
            }
            await waitForPoll(signal);
        }

        const elapsedMs = Date.now() - start;
        const diagnostics = await this.collectTimeoutDiagnostics(buildId, lastPod);
        this.logger.warn("Buildkit Job startup timed out", {
            extra: { buildId, phase: "startup", elapsedMs, diagnostics },
        });
        throw createBuildInfrastructureError(
            `Timed out after ${startupTimeoutMs}ms waiting for scheduled buildkit Job (build-id=${buildId}) to become Ready. ${diagnostics}`,
            { isTransient: true },
        );
    }

    private async readBuildPod(buildId: string): Promise<k8s.V1Pod | undefined> {
        const pods = await this.options.podsApi.listNamespacedPod({
            namespace: this.options.namespace,
            labelSelector: `${LABEL_BUILD_ID}=${buildId}`,
        });
        return pods.items[0];
    }

    private logPodStateChange(params: {
        buildId: string;
        phase: "provisioning" | "startup";
        pod: k8s.V1Pod;
        lastState: string | undefined;
        start: number;
    }): string {
        const state = describePodState(params.pod);
        if (state !== params.lastState) {
            this.logger.info("Buildkit pod state changed", {
                extra: {
                    buildId: params.buildId,
                    phase: params.phase,
                    state,
                    elapsedMs: Date.now() - params.start,
                },
            });
        }
        return state;
    }

    /**
     * provision()'s catch block deletes the Job before rethrowing, so the pod
     * state and its Events must be captured here - after release the evidence
     * is gone and `kubectl describe` has nothing to show.
     */
    private async collectTimeoutDiagnostics(buildId: string, lastPod: k8s.V1Pod | undefined): Promise<string> {
        const podState = describePodState(lastPod);
        const objectName = lastPod?.metadata?.name ?? `${NAME_PREFIX}-${buildId}`;
        const events = await this.readRecentEvents(objectName);
        if (events.length === 0) return `Last observed state: ${podState}. No events found.`;
        return `Last observed state: ${podState}. Recent events: ${events.join("; ")}`;
    }

    private async readRecentEvents(objectName: string): Promise<string[]> {
        try {
            const events = await this.options.podsApi.listNamespacedEvent({
                namespace: this.options.namespace,
                fieldSelector: `involvedObject.name=${objectName}`,
            });
            const sorted = [...events.items].sort((a, b) => eventTimeMs(a) - eventTimeMs(b));
            return sorted.slice(-MAX_DIAGNOSTIC_EVENTS).map(formatEvent);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.logger.warn("Failed to read events for buildkit timeout diagnostics", {
                extra: { objectName, error: error.message },
            });
            return [];
        }
    }

    private async waitForTcpReachable(pod: k8s.V1Pod, signal?: AbortSignal): Promise<string> {
        const host = pod.status?.podIP;
        if (host == null) {
            throw createBuildInfrastructureError(
                `Ready buildkit pod ${pod.metadata?.name ?? "unknown"} has no pod IP`,
                {
                    isTransient: true,
                },
            );
        }

        const deadline = Date.now() + DIAL_RETRY_BUDGET_MS;
        let attempts = 0;
        let lastError: Error | undefined;
        while (Date.now() < deadline) {
            throwIfAborted(signal);
            attempts += 1;
            try {
                await this.dial(host, BUILDKIT_PORT, DIAL_TIMEOUT_MS);
                if (attempts > 1) {
                    this.logger.info("Buildkit pod became reachable", { extra: { host, attempts } });
                }
                return `tcp://${host}:${BUILDKIT_PORT}`;
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                this.logger.debug("Buildkit pod is not reachable yet", {
                    extra: { host, attempts, error: lastError.message },
                });
                await waitForDelay(DIAL_RETRY_INTERVAL_MS, signal);
            }
        }

        throw createBuildInfrastructureError(
            `Buildkit pod ${host}:${BUILDKIT_PORT} did not accept connections within ${DIAL_RETRY_BUDGET_MS}ms (${attempts} attempts, last error: ${lastError?.message ?? "unknown"})`,
            { isTransient: true, cause: lastError },
        );
    }

    private jobSpec(name: string, buildId: string, identity: BuildJobIdentity): k8s.V1Job {
        const labels = {
            [LABEL_MANAGED_BY]: "previewkit",
            [LABEL_TYPE]: "build",
            [LABEL_BUILD_ID]: buildId,
            ...identityLabels(identity),
        };
        return {
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: { name, labels },
            spec: {
                backoffLimit: 0,
                activeDeadlineSeconds: this.options.activeDeadlineSeconds,
                ttlSecondsAfterFinished: TTL_SECONDS_AFTER_FINISHED,
                template: {
                    metadata: { labels },
                    spec: {
                        restartPolicy: "Never",
                        automountServiceAccountToken: false,
                        // Do not inject KUBERNETES_SERVICE_HOST/PORT into a pod
                        // that executes repository-controlled build steps. The
                        // egress policy also blocks cluster-private addresses,
                        // but omitting service links avoids disclosing the API
                        // endpoint in the build environment in the first place.
                        enableServiceLinks: false,
                        terminationGracePeriodSeconds: 30,
                        nodeSelector: {
                            "kubernetes.io/arch": "amd64",
                            pool: BUILD_NODE_POOL,
                        },
                        tolerations: [{ key: "pool", operator: "Equal", value: BUILD_NODE_POOL, effect: "NoSchedule" }],
                        affinity: {
                            nodeAffinity: {
                                requiredDuringSchedulingIgnoredDuringExecution: {
                                    nodeSelectorTerms: [
                                        {
                                            matchExpressions: [
                                                {
                                                    key: "karpenter.k8s.aws/instance-category",
                                                    operator: "In",
                                                    values: ["m"],
                                                },
                                                {
                                                    key: "karpenter.k8s.aws/instance-generation",
                                                    operator: "In",
                                                    values: ["6", "7", "8"],
                                                },
                                                {
                                                    key: "karpenter.k8s.aws/instance-size",
                                                    operator: "In",
                                                    values: ["xlarge"],
                                                },
                                            ],
                                        },
                                    ],
                                },
                                preferredDuringSchedulingIgnoredDuringExecution: [
                                    // Karpenter relaxes preferences from the lowest
                                    // weight. An m8 node satisfies both terms. If m8
                                    // capacity is unavailable, the m8-only term is
                                    // relaxed while the m7-or-m8 term keeps m7 ahead
                                    // of the required m6 fallback.
                                    {
                                        weight: 50,
                                        preference: {
                                            matchExpressions: [
                                                {
                                                    key: "karpenter.k8s.aws/instance-generation",
                                                    operator: "In",
                                                    values: ["8"],
                                                },
                                            ],
                                        },
                                    },
                                    {
                                        weight: 100,
                                        preference: {
                                            matchExpressions: [
                                                {
                                                    key: "karpenter.k8s.aws/instance-generation",
                                                    operator: "In",
                                                    values: ["7", "8"],
                                                },
                                            ],
                                        },
                                    },
                                ],
                            },
                            podAntiAffinity: {
                                requiredDuringSchedulingIgnoredDuringExecution: [
                                    {
                                        // Give each ephemeral buildkitd daemon
                                        // its own node.
                                        labelSelector: {
                                            matchLabels: { [LABEL_TYPE]: "build" },
                                        },
                                        topologyKey: "kubernetes.io/hostname",
                                    },
                                ],
                            },
                        },
                        containers: [
                            {
                                name: "buildkitd",
                                image: this.options.image,
                                args: ["--addr", `tcp://0.0.0.0:${BUILDKIT_PORT}`, "--config", BUILDKITD_CONFIG_FILE],
                                ports: [{ containerPort: BUILDKIT_PORT, name: "buildkit" }],
                                securityContext: { privileged: true, runAsUser: 0, runAsGroup: 0 },
                                readinessProbe: {
                                    tcpSocket: { port: BUILDKIT_PORT },
                                    initialDelaySeconds: 2,
                                    periodSeconds: 1,
                                    failureThreshold: 30,
                                },
                                volumeMounts: [
                                    {
                                        name: BUILDKITD_CONFIG_VOLUME,
                                        mountPath: BUILDKITD_CONFIG_MOUNT_PATH,
                                        readOnly: true,
                                    },
                                    {
                                        name: BUILDKITD_CACHE_VOLUME,
                                        mountPath: BUILDKITD_CACHE_MOUNT_PATH,
                                    },
                                ],
                            },
                        ],
                        volumes: [
                            {
                                name: BUILDKITD_CONFIG_VOLUME,
                                configMap: { name: BUILDKITD_CONFIG_CONFIGMAP },
                            },
                            {
                                name: BUILDKITD_CACHE_VOLUME,
                                emptyDir: {},
                            },
                        ],
                    },
                },
            },
        };
    }
}

function identityLabels(identity: BuildJobIdentity): Record<string, string> {
    const labels: Record<string, string> = {};
    const app = sanitizeLabelValue(identity.appName);
    if (app != null) labels[LABEL_APP] = app;
    const namespace = sanitizeLabelValue(identity.namespace);
    if (namespace != null) labels[LABEL_NAMESPACE] = namespace;
    const repo = sanitizeLabelValue(identity.repo);
    if (repo != null) labels[LABEL_REPO] = repo;
    if (identity.pr != null) labels[LABEL_PR] = String(identity.pr);
    return labels;
}

/**
 * Coerces an arbitrary string into a valid Kubernetes label value (interior
 * `-_.`, alphanumeric ends, <=63 chars) or `undefined` if nothing usable
 * remains. `acme/bank` -> `acme-bank`; an unlabelable value is dropped rather
 * than failing Job creation.
 */
function sanitizeLabelValue(value?: string): string | undefined {
    if (value == null || value === "") return undefined;
    const cleaned = value
        .replace(/[^A-Za-z0-9_.-]/g, "-")
        .replace(/^[^A-Za-z0-9]+/, "")
        .slice(0, LABEL_VALUE_MAX)
        .replace(/[^A-Za-z0-9]+$/, "");
    return cleaned === "" ? undefined : cleaned;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted !== true) return;
    throw new BuildAbortedError("Buildkit provisioning aborted (build cancelled)", { cause: signal.reason });
}

async function waitForPoll(signal?: AbortSignal): Promise<void> {
    await waitForDelay(READINESS_POLL_INTERVAL_MS, signal);
}

async function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new BuildAbortedError("Buildkit provisioning aborted (build cancelled)", { cause: signal?.reason }));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function tryConnect(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ host, port });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`dial ${host}:${port} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        socket.once("connect", () => {
            clearTimeout(timer);
            socket.end();
            resolve();
        });
        socket.once("error", (err) => {
            clearTimeout(timer);
            socket.destroy();
            reject(err);
        });
    });
}

function toProvisionBuildError(err: unknown): BuildError {
    if (err instanceof BuildError) return err;
    const cause = err instanceof Error ? err : new Error(String(err));
    const isTransient = !(err instanceof ApiException) || isTransientStatusCode(err.code);
    return createBuildInfrastructureError(`Failed to provision buildkit infrastructure: ${cause.message}`, {
        cause,
        isTransient,
    });
}

function createBuildInfrastructureError(
    message: string,
    options?: { cause?: unknown; isTransient?: boolean; userFacingMessage?: string },
): BuildError {
    return new BuildError(message, {
        cause: options?.cause,
        isTransient: options?.isTransient,
        userFacingMessage: options?.userFacingMessage ?? BUILD_MESSAGES.infrastructureUnavailable,
    });
}

function isTransientStatusCode(statusCode: number): boolean {
    if (statusCode <= 0 || statusCode >= 500) return true;
    return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429;
}

function isScheduled(pod: k8s.V1Pod): boolean {
    return (
        pod.status?.conditions?.some((condition) => condition.type === "PodScheduled" && condition.status === "True") ??
        false
    );
}

function isReady(pod: k8s.V1Pod): boolean {
    return (
        pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") ?? false
    );
}

function describePodState(pod: k8s.V1Pod | undefined): string {
    if (pod == null) return "no pod exists for the build Job";
    const parts = [
        `pod=${pod.metadata?.name ?? "unknown"}`,
        `node=${pod.spec?.nodeName ?? "unscheduled"}`,
        `phase=${pod.status?.phase ?? "Unknown"}`,
    ];
    for (const condition of pod.status?.conditions ?? []) {
        if (condition.status === "True") continue;
        if (condition.type !== "PodScheduled" && condition.type !== "Ready") continue;
        const detail = [condition.reason, condition.message].filter((part) => part != null).join(": ");
        parts.push(`${condition.type}=${condition.status}${detail === "" ? "" : ` (${detail})`}`);
    }
    for (const status of pod.status?.containerStatuses ?? []) {
        parts.push(`container=${status.name} ${describeContainerState(status)}`);
        if (status.restartCount > 0) parts.push(`restarts=${status.restartCount}`);
    }
    return parts.join(" ");
}

function describeContainerState(status: k8s.V1ContainerStatus): string {
    const waiting = status.state?.waiting;
    if (waiting != null) {
        return `waiting (${waiting.reason ?? "unknown"}${waiting.message != null ? `: ${waiting.message}` : ""})`;
    }
    const terminated = status.state?.terminated;
    if (terminated != null) {
        return `terminated (${terminated.reason ?? "unknown"}, exit ${terminated.exitCode ?? "unknown"})`;
    }
    if (status.state?.running != null) {
        return status.ready ? "running (ready)" : "running (not ready)";
    }
    return "state unknown";
}

function formatEvent(event: k8s.CoreV1Event): string {
    const count = event.count != null && event.count > 1 ? ` x${event.count}` : "";
    const message = truncateEventMessage(event.message?.trim() ?? "");
    return `${event.reason ?? "Unknown"}${count}: ${message}`;
}

function truncateEventMessage(message: string): string {
    if (message.length <= EVENT_MESSAGE_MAX_CHARS) return message;
    return `${message.slice(0, EVENT_MESSAGE_MAX_CHARS)}...`;
}

function eventTimeMs(event: k8s.CoreV1Event): number {
    const timestamp = event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp;
    return timestamp != null ? new Date(timestamp).getTime() : 0;
}

interface PodFailure {
    message: string;
    transient: boolean;
}

const PERMANENT_WAITING_REASONS = new Set([
    "InvalidImageName",
    "CreateContainerConfigError",
    "CreateContainerError",
    "CrashLoopBackOff",
]);

const TRANSIENT_WAITING_REASONS = new Set(["ImagePullBackOff", "ErrImagePull"]);

const PERMANENT_TERMINATED_REASONS = new Set(["StartError", "ContainerCannotRun"]);

function throwForPodFailure(pod: k8s.V1Pod): void {
    const failure = classifyPodFailure(pod);
    if (failure == null) return;
    throw createBuildInfrastructureError(failure.message, { isTransient: failure.transient });
}

function classifyPodFailure(pod: k8s.V1Pod): PodFailure | undefined {
    const podName = pod.metadata?.name ?? "unknown";
    if (pod.status?.phase === "Failed" && pod.status.reason === "Evicted") {
        return {
            transient: true,
            message: `Buildkit pod ${podName} was evicted: ${pod.status.message ?? "unknown reason"}`,
        };
    }

    for (const status of pod.status?.containerStatuses ?? []) {
        const terminated = status.state?.terminated;
        if (terminated?.reason === "OOMKilled") {
            return {
                transient: true,
                message: `Buildkit pod ${podName} was OOMKilled (exit ${terminated.exitCode ?? "unknown"})`,
            };
        }
        if (terminated?.reason != null && PERMANENT_TERMINATED_REASONS.has(terminated.reason)) {
            return {
                transient: false,
                message: `Buildkit pod ${podName} failed to start (${terminated.reason}): ${terminated.message ?? ""}`,
            };
        }
        if (terminated != null) {
            return {
                // Node shutdown and spot interruption often surface only as
                // `Error`/143 rather than `Evicted`. Unknown daemon exits are
                // therefore retried with a fresh isolated Job; known config and
                // startup failures were handled as permanent above.
                transient: true,
                message: `Buildkit pod ${podName} terminated (${terminated.reason ?? "unknown"}, exit ${terminated.exitCode ?? "unknown"}): ${terminated.message ?? ""}`,
            };
        }

        const waiting = status.state?.waiting;
        if (waiting?.reason != null && TRANSIENT_WAITING_REASONS.has(waiting.reason)) {
            return {
                transient: true,
                message: `Buildkit pod ${podName} could not pull its image (${waiting.reason}): ${waiting.message ?? ""}`,
            };
        }
        if (waiting?.reason != null && PERMANENT_WAITING_REASONS.has(waiting.reason)) {
            return {
                transient: false,
                message: `Buildkit pod ${podName} failed to start (${waiting.reason}): ${waiting.message ?? ""}`,
            };
        }
    }

    if (pod.status?.phase === "Failed") {
        return {
            transient: true,
            message: `Buildkit pod ${podName} failed (${pod.status.reason ?? "unknown"}): ${pod.status.message ?? ""}`,
        };
    }

    return undefined;
}
