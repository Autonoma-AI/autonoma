import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import * as k8s from "@kubernetes/client-node";
import { isNotFound } from "../deployer/k8s-errors";
import { logger as rootLogger, type Logger } from "../logger";
import { BuildError } from "./builder";

const NAME_PREFIX = "pk-builder";
const LABEL_MANAGED_BY = "previewkit.dev/managed-by";
const LABEL_TYPE = "previewkit.dev/type";
const LABEL_BUILD_ID = "previewkit.dev/build-id";
const BUILDKIT_PORT = 1234;
// 16 hex chars (8 random bytes) is plenty for collision-free naming without
// padding the K8s resource name beyond the 63-char DNS label limit.
const BUILD_ID_BYTES = 8;
const READINESS_POLL_INTERVAL_MS = 500;
const DEFAULT_READINESS_TIMEOUT_MS = 90_000;
// Per-dial timeout for the post-Ready TCP probe. The connect should complete
// in low single-digit milliseconds in-cluster; this is just an outer bound.
const DIAL_TIMEOUT_MS = 2_000;
// Total budget for the kube-proxy / endpoints lag after Pod.status.Ready
// flips True. In practice this is sub-second; 30s is room to spare.
const DIAL_RETRY_BUDGET_MS = 30_000;
const DIAL_RETRY_INTERVAL_MS = 500;
// Auto-clean completed Jobs from the cluster after this many seconds. The
// previewkit pipeline normally calls release() on completion, so this is only
// a backstop for previewkit crashes mid-build.
const TTL_SECONDS_AFTER_FINISHED = 600;

interface BuildKitJobManagerOptions {
    kc: k8s.KubeConfig;
    /** Namespace where buildkit Jobs are created. Should be dedicated so RBAC
     *  / quotas / NetworkPolicies can target it cleanly. */
    namespace: string;
    /** Image with the buildkitd daemon. */
    image: string;
    /** ServiceAccount the build pods run as. Must exist in `namespace` and
     *  carry the IRSA annotation for S3 cache access. */
    serviceAccountName: string;
    /** Hard upper bound on a single Job (seconds). Passed straight to
     *  Job.spec.activeDeadlineSeconds so K8s self-terminates stuck builds
     *  even if previewkit crashed before calling release(). */
    activeDeadlineSeconds: number;
    /** Override the TCP dial probe used after Pod becomes Ready. Production
     *  uses the default (node:net createConnection); tests inject a fake
     *  that resolves without doing real I/O. */
    dial?: (host: string, port: number, timeoutMs: number) => Promise<void>;
}

export interface BuildKitInstance {
    /** K8s resource name. Same value for the Job and Service. */
    name: string;
    /** Random 16-hex-char id encoded into `name`; also the value of the
     *  `previewkit.dev/build-id` label used by the Service selector. */
    buildId: string;
    /** Stable in-cluster DNS endpoint:
     *  `tcp://<name>.<namespace>.svc.cluster.local:1234`. Hand this to
     *  buildctl as `--addr`. */
    host: string;
}

/**
 * Spawns one ephemeral buildkitd per app build (as a K8s Job) and tears it
 * down on release. The Service alongside the Job gives buildctl a stable
 * DNS name to dial; the Job's ownerReference on the Service makes K8s GC
 * cascade so a single delete-job call cleans up both.
 *
 * Lives in the previewkit control cluster (the same cluster previewkit
 * itself runs in). Client preview workloads run in a separate cluster -
 * builds don't share node resources with running previews anymore.
 */
export class BuildKitJobManager {
    private readonly batchApi: k8s.BatchV1Api;
    private readonly coreApi: k8s.CoreV1Api;
    private readonly logger: Logger;
    private readonly dial: (host: string, port: number, timeoutMs: number) => Promise<void>;

    constructor(private readonly options: BuildKitJobManagerOptions) {
        this.batchApi = options.kc.makeApiClient(k8s.BatchV1Api);
        this.coreApi = options.kc.makeApiClient(k8s.CoreV1Api);
        this.logger = rootLogger.child({ name: this.constructor.name });
        this.dial = options.dial ?? tryConnect;
    }

    /**
     * Creates the Job + Service, waits for the pod to be Ready, returns the
     * connection info. On any failure during this sequence the partial state
     * is cleaned up before throwing - callers can treat a thrown provision()
     * as "no resources leaked".
     */
    async provision(): Promise<BuildKitInstance> {
        const buildId = randomBytes(BUILD_ID_BYTES).toString("hex");
        const name = `${NAME_PREFIX}-${buildId}`;
        const namespace = this.options.namespace;

        this.logger.info("Provisioning buildkit Job", { name, namespace });

        const createdJob = await this.batchApi.createNamespacedJob({
            namespace,
            body: this.jobSpec(name, buildId),
        });

        try {
            await this.coreApi.createNamespacedService({
                namespace,
                body: this.serviceSpec(name, buildId, createdJob),
            });

            await this.waitForReady(buildId);

            // Pod.status.Ready trips when kubelet's TCP probe succeeds from
            // inside the pod's net namespace - but there's a separate lag
            // before the endpoints controller wires the pod into the Service
            // backends and kube-proxy programs its iptables. Hand control to
            // buildctl during that window and the first dial gets RST'd.
            // Probe with a real TCP connect from this pod before returning.
            const dnsName = `${name}.${namespace}.svc.cluster.local`;
            await this.waitForTcpReachable(dnsName);

            const host = `tcp://${dnsName}:${BUILDKIT_PORT}`;
            this.logger.info("Buildkit Job ready", { name, host });
            return { name, buildId, host };
        } catch (err) {
            await this.release({ name }).catch((cleanupErr) => {
                this.logger.warn("Cleanup after failed provision also failed", { name, cleanupErr });
            });
            throw err;
        }
    }

    /**
     * Deletes the Job. The Service is GC'd automatically via its
     * ownerReference. Idempotent - silent on NotFound so callers in `finally`
     * blocks don't have to special-case repeated cleanup.
     */
    async release(instance: { name: string }): Promise<void> {
        const { namespace } = this.options;
        this.logger.info("Releasing buildkit Job", { name: instance.name, namespace });

        try {
            await this.batchApi.deleteNamespacedJob({
                name: instance.name,
                namespace,
                propagationPolicy: "Background",
            });
        } catch (err) {
            if (isNotFound(err)) return;
            throw err;
        }
    }

    /**
     * Real TCP dial against the Service hostname, retrying on ECONNREFUSED /
     * timeout / DNS failures until kube-proxy has wired the new pod into
     * iptables. Returns void on the first successful connect; throws a
     * transient BuildError after `DIAL_RETRY_BUDGET_MS` so the retry loop in
     * BuildKitBuilder picks it up and tries a fresh Job.
     *
     * Without this, `Pod.status.Ready` says "yes, kubelet's loopback probe
     * succeeded" before the endpoints controller and kube-proxy finish their
     * own propagation, and buildctl gets `connection refused` on its first
     * attempt against an IP that resolves but has no backend yet.
     */
    private async waitForTcpReachable(host: string): Promise<void> {
        const deadline = Date.now() + DIAL_RETRY_BUDGET_MS;
        let attempts = 0;
        let lastErr: Error | undefined;
        while (Date.now() < deadline) {
            attempts++;
            try {
                await this.dial(host, BUILDKIT_PORT, DIAL_TIMEOUT_MS);
                if (attempts > 1) {
                    this.logger.info("buildkit Service became reachable", { host, attempts });
                }
                return;
            } catch (err) {
                lastErr = err instanceof Error ? err : new Error(String(err));
                await new Promise<void>((res) => setTimeout(res, DIAL_RETRY_INTERVAL_MS));
            }
        }
        throw new BuildError(
            `buildkit Service ${host}:${BUILDKIT_PORT} did not accept connections within ${DIAL_RETRY_BUDGET_MS}ms (${attempts} attempts, last error: ${lastErr?.message ?? "unknown"})`,
            { isTransient: true, cause: lastErr },
        );
    }

    private async waitForReady(buildId: string): Promise<void> {
        const start = Date.now();
        const { namespace } = this.options;
        const selector = `${LABEL_BUILD_ID}=${buildId}`;

        while (Date.now() - start < DEFAULT_READINESS_TIMEOUT_MS) {
            const pods = await this.coreApi.listNamespacedPod({ namespace, labelSelector: selector });
            const pod = pods.items[0];

            if (pod != null) {
                const ready = pod.status?.conditions?.find((c) => c.type === "Ready");
                if (ready?.status === "True") return;

                const failure = classifyPodFailure(pod);
                if (failure != null) {
                    throw new BuildError(failure.message, { isTransient: failure.transient });
                }
            }

            await new Promise<void>((res) => setTimeout(res, READINESS_POLL_INTERVAL_MS));
        }

        // Readiness timeout is treated as transient: usually means the
        // autoscaler is still bringing a node online for the build, and
        // a fresh provision on the next attempt is likely to schedule.
        throw new BuildError(
            `Timed out waiting for buildkit Job (build-id=${buildId}) to become ready after ${DEFAULT_READINESS_TIMEOUT_MS}ms`,
            { isTransient: true },
        );
    }

    private jobSpec(name: string, buildId: string): k8s.V1Job {
        const labels = {
            [LABEL_MANAGED_BY]: "previewkit",
            [LABEL_TYPE]: "build",
            [LABEL_BUILD_ID]: buildId,
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
                        serviceAccountName: this.options.serviceAccountName,
                        affinity: {
                            podAntiAffinity: {
                                // Soft preference - the scheduler tries to put
                                // one build pod per node so heavy builds don't
                                // contend, but won't refuse to schedule when
                                // every node already has one (burst load).
                                preferredDuringSchedulingIgnoredDuringExecution: [
                                    {
                                        weight: 100,
                                        podAffinityTerm: {
                                            labelSelector: { matchLabels: { [LABEL_TYPE]: "build" } },
                                            topologyKey: "kubernetes.io/hostname",
                                        },
                                    },
                                ],
                            },
                        },
                        containers: [
                            {
                                name: "buildkitd",
                                image: this.options.image,
                                args: ["--addr", `tcp://0.0.0.0:${BUILDKIT_PORT}`],
                                ports: [{ containerPort: BUILDKIT_PORT, name: "buildkit" }],
                                // Privileged is required for buildkitd's overlayfs
                                // worker on a stock kernel. Rootless mode is a v2
                                // hardening; for v1 we accept the same posture as
                                // the previous long-lived buildkitd Deployment.
                                securityContext: { privileged: true },
                                readinessProbe: {
                                    tcpSocket: { port: BUILDKIT_PORT },
                                    initialDelaySeconds: 2,
                                    periodSeconds: 1,
                                    failureThreshold: 30,
                                },
                                resources: {
                                    requests: { cpu: "1", memory: "2Gi" },
                                    limits: { cpu: "4", memory: "8Gi" },
                                },
                            },
                        ],
                    },
                },
            },
        };
    }

    private serviceSpec(name: string, buildId: string, job: k8s.V1Job): k8s.V1Service {
        const uid = job.metadata?.uid;
        if (uid == null) {
            throw new Error(`Job ${name} has no metadata.uid - cannot set ownerReference on the Service`);
        }
        return {
            apiVersion: "v1",
            kind: "Service",
            metadata: {
                name,
                labels: {
                    [LABEL_MANAGED_BY]: "previewkit",
                    [LABEL_TYPE]: "build",
                    [LABEL_BUILD_ID]: buildId,
                },
                // Tying the Service's lifetime to the Job: when the Job is
                // deleted (or its TTL kicks in), K8s GC removes the Service
                // too. One delete-job call handles both resources.
                ownerReferences: [
                    {
                        apiVersion: "batch/v1",
                        kind: "Job",
                        name,
                        uid,
                        controller: true,
                        blockOwnerDeletion: true,
                    },
                ],
            },
            spec: {
                selector: { [LABEL_BUILD_ID]: buildId },
                ports: [{ port: BUILDKIT_PORT, targetPort: BUILDKIT_PORT, name: "buildkit" }],
            },
        };
    }
}

/**
 * One TCP connect attempt with a hard timeout. Resolves on `connect`, rejects
 * on socket error or when the timeout fires first. The socket is always
 * destroyed before resolving / rejecting so we don't leak FDs across retries.
 */
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

interface PodFailure {
    message: string;
    /** True if the right move is to provision a fresh Job and retry (e.g.
     *  node-pressure eviction, spot interruption). False for config errors
     *  that would just repeat (bad image, container crash loop). */
    transient: boolean;
}

/**
 * Reads pod status and returns a structured failure for callers to surface
 * (or null if the pod is still progressing toward Ready). Distinguishes:
 *
 *   - Pod-level Failed phase with reason="Evicted" → transient. Node ran
 *     out of CPU/memory/disk and kubelet killed the pod; another node has
 *     a real chance of accepting it.
 *   - Container terminated with OOMKilled → transient. Sometimes a noisy
 *     neighbour or a hot start; the next attempt may find a quieter node.
 *     Operators tune resource requests if it recurs.
 *   - Container waiting in ImagePullBackOff / ErrImagePull → permanent.
 *     The image name is wrong or the registry is unreachable; retrying
 *     just burns retry budget. Surface immediately.
 *   - Container waiting in CrashLoopBackOff → permanent. buildkitd
 *     wouldn't crash loop except for a config / privilege issue.
 */
function classifyPodFailure(pod: k8s.V1Pod): PodFailure | null {
    if (pod.status?.phase === "Failed" && pod.status.reason === "Evicted") {
        return {
            transient: true,
            message: `Buildkit pod ${pod.metadata?.name} was evicted: ${pod.status.message ?? "unknown reason"}`,
        };
    }

    for (const cs of pod.status?.containerStatuses ?? []) {
        const terminated = cs.state?.terminated;
        if (terminated?.reason === "OOMKilled") {
            return {
                transient: true,
                message: `Buildkit pod ${pod.metadata?.name} OOMKilled (exit ${terminated.exitCode ?? "?"})`,
            };
        }

        const waiting = cs.state?.waiting;
        const reason = waiting?.reason;
        if (reason === "ImagePullBackOff" || reason === "ErrImagePull") {
            return {
                transient: false,
                message: `Buildkit pod ${pod.metadata?.name} failed to start (${reason}): ${waiting?.message ?? ""}`,
            };
        }
        if (reason === "CrashLoopBackOff") {
            return {
                transient: false,
                message: `Buildkit pod ${pod.metadata?.name} crash-looped: ${waiting?.message ?? ""}`,
            };
        }
    }

    return null;
}
