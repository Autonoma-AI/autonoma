import { createHash } from "node:crypto";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { TriggerPreviewDeployParams, TriggerPreviewTeardownParams } from "@autonoma/workflow";
import type { PreviewDeployEvent } from "@autonoma/workflow/activities";
import { ApiException, type V1Job } from "@kubernetes/client-node";

/**
 * The slice of `@kubernetes/client-node`'s `BatchV1Api` the launcher uses.
 * `BatchV1Api` satisfies it structurally, so the launcher depends on this seam
 * (injected) and tests pass a lightweight fake instead of faking a real client.
 */
export interface PreviewJobsApi {
    listNamespacedJob(params: { namespace: string; labelSelector?: string }): Promise<{ items: V1Job[] }>;
    createNamespacedJob(params: { namespace: string; body: V1Job }): Promise<V1Job>;
    deleteNamespacedJob(params: { name: string; namespace: string; propagationPolicy?: string }): Promise<unknown>;
}

/** The slice of `CoreV1Api` used to read the runner-image ConfigMap. */
export interface ConfigMapReader {
    readNamespacedConfigMap(params: { name: string; namespace: string }): Promise<{ data?: Record<string, string> }>;
}

const LABEL_MANAGED_BY = "previewkit.dev/managed-by";
const LABEL_TYPE = "previewkit.dev/type";
const LABEL_ENV = "previewkit.dev/env";
const LABEL_PR = "previewkit.dev/pr";
const ANNOTATION_REPO = "previewkit.dev/repo";
const ANNOTATION_HEAD_SHA = "previewkit.dev/head-sha";

// Reused from the previewkit worker (deployment/apps/worker-previewkit.yaml): the
// runner Job runs as the same ServiceAccount, on the same node pool, and pulls
// the same env (the secret bundle plus a small non-secret ConfigMap).
const RUNNER_SERVICE_ACCOUNT = "previewkit";
const RUNNER_ENV_SECRET = "previewkit-env-file";
const RUNNER_ENV_CONFIGMAP = "previewkit-runner-env";
const RUNNER_NODE_POOL = "temporal";
const RUNNER_COMMAND = ["/app/node_modules/.bin/tsx", "src/runner/index.ts"];

// The previewkit deploy (deploy-worker-previewkit) writes the exact SHA-pinned
// image it deployed into this ConfigMap's `image` key; the launcher reads it so
// runner Jobs are pinned to the currently-deployed previewkit image, decoupled
// from the API's own image/SHA.
const RUNNER_IMAGE_CONFIGMAP = "previewkit-runner-image";
const RUNNER_IMAGE_KEY = "image";

const TTL_AFTER_FINISHED_SECONDS = 3_600;
const DEPLOY_GRACE_SECONDS = 120;
const TEARDOWN_GRACE_SECONDS = 300;
const NAME_SLUG_MAX = 28;

/** Mirrors apps/previewkit/src/runner/job-spec.ts `PreviewJobSpec`. */
interface PreviewJobInput {
    mode: "deploy" | "teardown";
    event: PreviewDeployEvent;
    configRevisionId?: string;
}

export interface PreviewkitJobLauncherOptions {
    batchApi: PreviewJobsApi;
    coreApi: ConfigMapReader;
    /** Namespace the runner Jobs are created in (the API's own namespace). */
    namespace: string;
    /**
     * Hard upper bound on a deploy Job (seconds). A generous backstop *above*
     * the runner's own BUILD_TIMEOUT_MS / readiness timeouts, so a real build
     * timeout surfaces as a recorded failure rather than an external deadline
     * SIGTERM (which the runner would read as a supersede).
     */
    deployDeadlineSeconds?: number;
    teardownDeadlineSeconds?: number;
}

/**
 * Launches one Kubernetes Job per preview deploy/teardown, the Jobs replacement
 * for starting a Temporal workflow. The Job runs apps/previewkit's one-shot
 * runner. Concurrency is async newest-wins: each launch first SIGTERMs any
 * in-flight Job for the same (repo, PR) - the per-environment mutex, carried on
 * the `previewkit.dev/env` label - then creates a fresh Job. The old pod
 * self-drains (aborts buildctl, writes the superseded build row); the new pod
 * owns the environment row, exactly as the Temporal supersede did.
 *
 * The runner image is SHA-pinned: it is read from the `previewkit-runner-image`
 * ConfigMap that the previewkit deploy writes, so Jobs always run the exact
 * currently-deployed previewkit image regardless of the API's own deploy SHA.
 *
 * `launchDeploy` / `launchTeardown` match the `triggerPreviewDeploy` /
 * `triggerPreviewTeardown` signatures, so they drop into the same injection
 * seam in PreviewkitTriggerService.
 */
export class PreviewkitJobLauncher {
    private readonly batchApi: PreviewJobsApi;
    private readonly coreApi: ConfigMapReader;
    private readonly logger: Logger;

    constructor(private readonly options: PreviewkitJobLauncherOptions) {
        this.batchApi = options.batchApi;
        this.coreApi = options.coreApi;
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async launchDeploy(params: TriggerPreviewDeployParams): Promise<void> {
        const { event, configRevisionId } = params;
        const envKey = previewEnvKey(event.repoFullName, event.prNumber);
        this.logger.info("Launching preview deploy job", {
            extra: { envKey, repo: event.repoFullName, pr: event.prNumber, sha: event.headSha.slice(0, 7) },
        });
        // Resolve the runner image first: a missing image must fail before we
        // supersede the in-flight deploy, so we never kill a running run we
        // cannot replace.
        const image = await this.resolveRunnerImage();
        await this.supersedeInFlightDeploys(envKey);
        const spec: PreviewJobInput = {
            mode: "deploy",
            event,
            ...(configRevisionId != null ? { configRevisionId } : {}),
        };
        await this.createJob("deploy", envKey, event, spec, image, this.deployDeadlineSeconds(), DEPLOY_GRACE_SECONDS);
    }

    async launchTeardown(params: TriggerPreviewTeardownParams): Promise<void> {
        const { event } = params;
        const envKey = previewEnvKey(event.repoFullName, event.prNumber);
        this.logger.info("Launching preview teardown job", {
            extra: { envKey, repo: event.repoFullName, pr: event.prNumber },
        });
        const image = await this.resolveRunnerImage();
        // Teardown supersedes an in-flight deploy (same env mutex) but never
        // another teardown - a close-then-reopen lets the deletion finish first.
        await this.supersedeInFlightDeploys(envKey);
        const spec: PreviewJobInput = { mode: "teardown", event };
        await this.createJob("teardown", envKey, event, spec, image, this.teardownDeadlineSeconds(), TEARDOWN_GRACE_SECONDS);
    }

    /**
     * Reads the SHA-pinned runner image the previewkit deploy recorded in the
     * `previewkit-runner-image` ConfigMap. Throws a clear error when it is
     * absent (previewkit not deployed yet) so a launch fails loudly rather than
     * creating an unschedulable Job.
     */
    private async resolveRunnerImage(): Promise<string> {
        const { namespace } = this.options;
        let cm: { data?: Record<string, string> };
        try {
            cm = await this.coreApi.readNamespacedConfigMap({ name: RUNNER_IMAGE_CONFIGMAP, namespace });
        } catch (err) {
            if (isNotFound(err)) {
                throw new Error(
                    `ConfigMap ${RUNNER_IMAGE_CONFIGMAP} not found in ${namespace} - deploy worker-previewkit before enabling jobs mode`,
                );
            }
            throw err;
        }
        const image = cm.data?.[RUNNER_IMAGE_KEY];
        if (image == null || image === "") {
            throw new Error(`ConfigMap ${RUNNER_IMAGE_CONFIGMAP} has no '${RUNNER_IMAGE_KEY}' key`);
        }
        return image;
    }

    /**
     * SIGTERMs every in-flight deploy Job for an env (Background propagation so
     * the pod is deleted gracefully, triggering the runner's supersede drain).
     * Best-effort: a list/delete failure is logged but never blocks the new
     * launch - newest-wins ownership in the DB tolerates a brief overlap.
     */
    private async supersedeInFlightDeploys(envKey: string): Promise<void> {
        const { namespace } = this.options;
        const labelSelector = `${LABEL_ENV}=${envKey},${LABEL_TYPE}=deploy`;
        let jobs;
        try {
            jobs = await this.batchApi.listNamespacedJob({ namespace, labelSelector });
        } catch (err) {
            this.logger.warn("Failed to list in-flight preview jobs to supersede; proceeding to create the new one", {
                extra: { envKey, err },
            });
            return;
        }
        for (const job of jobs.items) {
            const name = job.metadata?.name;
            if (name == null) continue;
            try {
                await this.batchApi.deleteNamespacedJob({ name, namespace, propagationPolicy: "Background" });
                this.logger.info("Superseded in-flight preview deploy job", { extra: { envKey, supersededJob: name } });
            } catch (err) {
                if (isNotFound(err)) continue;
                this.logger.warn("Failed to delete superseded preview job; relying on newest-wins ownership", {
                    extra: { envKey, supersededJob: name, err },
                });
            }
        }
    }

    private async createJob(
        type: "deploy" | "teardown",
        envKey: string,
        event: PreviewDeployEvent,
        spec: PreviewJobInput,
        image: string,
        deadlineSeconds: number,
        graceSeconds: number,
    ): Promise<void> {
        const { namespace } = this.options;
        const created = await this.batchApi.createNamespacedJob({
            namespace,
            body: this.jobSpec(type, envKey, event, spec, image, deadlineSeconds, graceSeconds),
        });
        this.logger.info("Created preview job", { extra: { envKey, type, image, job: created.metadata?.name } });
    }

    private jobSpec(
        type: "deploy" | "teardown",
        envKey: string,
        event: PreviewDeployEvent,
        spec: PreviewJobInput,
        image: string,
        deadlineSeconds: number,
        graceSeconds: number,
    ): V1Job {
        const labels = {
            [LABEL_MANAGED_BY]: "previewkit",
            [LABEL_TYPE]: type,
            [LABEL_ENV]: envKey,
            [LABEL_PR]: String(event.prNumber),
        };
        return {
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: {
                generateName: `pk-${type}-${nameSlug(event.repoFullName, NAME_SLUG_MAX)}-${event.prNumber}-`,
                labels,
                annotations: {
                    [ANNOTATION_REPO]: event.repoFullName,
                    [ANNOTATION_HEAD_SHA]: event.headSha,
                },
            },
            spec: {
                // One crash-retry. The runner records every *handled* outcome and
                // exits 0, so a retry only happens on an unexpected pod death
                // (OOM / node eviction); the idempotent upserts make the re-run
                // from `prepare` safe.
                backoffLimit: 1,
                activeDeadlineSeconds: deadlineSeconds,
                ttlSecondsAfterFinished: TTL_AFTER_FINISHED_SECONDS,
                template: {
                    metadata: { labels },
                    spec: {
                        restartPolicy: "Never",
                        serviceAccountName: RUNNER_SERVICE_ACCOUNT,
                        terminationGracePeriodSeconds: graceSeconds,
                        nodeSelector: { pool: RUNNER_NODE_POOL },
                        tolerations: [
                            { key: "pool", operator: "Equal", value: RUNNER_NODE_POOL, effect: "NoSchedule" },
                        ],
                        containers: [
                            {
                                name: "runner",
                                // SHA-pinned (immutable) image from the runner-image
                                // ConfigMap, so the default IfNotPresent pull policy is
                                // correct - no need to re-pull a fixed tag.
                                image,
                                command: RUNNER_COMMAND,
                                envFrom: [
                                    { secretRef: { name: RUNNER_ENV_SECRET } },
                                    { configMapRef: { name: RUNNER_ENV_CONFIGMAP } },
                                ],
                                env: [{ name: "PREVIEWKIT_JOB_SPEC", value: JSON.stringify(spec) }],
                                resources: {
                                    requests: { cpu: "500m", memory: "1Gi" },
                                    limits: { memory: "4Gi" },
                                },
                            },
                        ],
                    },
                },
            },
        };
    }

    private deployDeadlineSeconds(): number {
        return this.options.deployDeadlineSeconds ?? 60 * 60;
    }

    private teardownDeadlineSeconds(): number {
        return this.options.teardownDeadlineSeconds ?? 15 * 60;
    }
}

/**
 * Deterministic, label-safe (<=63 chars) mutex key per (repo, PR). A short hash
 * of the repo keeps it within the label-length limit for arbitrarily long repo
 * names while staying unique; the readable repo name lives in an annotation.
 */
export function previewEnvKey(repoFullName: string, prNumber: number): string {
    const hash = createHash("sha256").update(repoFullName).digest("hex").slice(0, 12);
    return `${hash}-${prNumber}`;
}

/** DNS-1123-safe, length-capped slug for the human-readable part of a Job name. */
function nameSlug(repoFullName: string, max: number): string {
    const slug = repoFullName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug.length <= max ? slug : slug.slice(0, max).replace(/-+$/g, "");
}

function isNotFound(err: unknown): boolean {
    return err instanceof ApiException && err.code === 404;
}
