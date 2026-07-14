import { createHash } from "node:crypto";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type {
    PreviewDeployEvent,
    TriggerPreviewDeployParams,
    TriggerPreviewRedeployAppParams,
    TriggerPreviewTeardownParams,
} from "@autonoma/types";
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
const ANNOTATION_DO_NOT_DISRUPT = "karpenter.sh/do-not-disrupt";

const RUNNER_SERVICE_ACCOUNT = "previewkit";
const RUNNER_ENV_SECRET = "previewkit-env-file";
const RUNNER_NODE_POOL = "previewkit";
const RUNNER_COMMAND = ["node", "--enable-source-maps", "/app/dist/index.js"];
const RUNNER_IMAGE_CONFIGMAP = "previewkit-runner-image";
const RUNNER_IMAGE_KEY = "image";

const TTL_AFTER_FINISHED_SECONDS = 3_600;
const DEPLOY_GRACE_SECONDS = 120;
const TEARDOWN_GRACE_SECONDS = 300;
const NAME_SLUG_MAX = 28;

type JobType = "deploy" | "teardown" | "redeploy-app";

// The "deploy family" - deploy and per-app redeploy share the per-environment
// mutex (the Temporal workflows shared one workflowId), so launching either
// supersedes any in-flight one. Teardown is excluded: a running teardown is
// left to finish (the Jobs equivalent of its nonCancellable scope).
const DEPLOY_FAMILY_SELECTOR = `${LABEL_TYPE} in (deploy,redeploy-app)`;

/** Mirrors apps/previewkit/src/runner/job-spec.ts `PreviewJobSpec`. */
type PreviewJobInput =
    | { mode: "deploy"; event: PreviewDeployEvent }
    | { mode: "teardown"; event: PreviewDeployEvent }
    | {
          mode: "redeploy-app";
          event: PreviewDeployEvent;
          namespace: string;
          appName: string;
          redeployMode: "rebuild" | "restart";
      };

export interface PreviewkitJobLauncherOptions {
    batchApi: PreviewJobsApi;
    coreApi: ConfigMapReader;
    /**
     * Namespace the runner Jobs are created in - the shared, dedicated
     * `previewkit` namespace that holds the previewkit SA and env secret the
     * Jobs mount.
     */
    jobNamespace: string;
    /**
     * Namespace the per-env `previewkit-runner-image` ConfigMap is read from -
     * the API's own namespace (production / beta / alpha). Each environment pins
     * its own runner image there; the resolved image is baked into the Job spec,
     * so the Job (created in `jobNamespace`) runs the launching env's image.
     */
    imageNamespace: string;
    /**
     * The launching API's own `DATABASE_URL`. Injected as an explicit env var on
     * the runner container so the runner writes preview rows to the SAME database
     * the launching API reads from (production -> prod DB, beta -> beta DB,
     * alpha -> that alpha env's DB). It overrides the `DATABASE_URL` the shared
     * `previewkit-env-file` secret carries (always the production bundle), and
     * must be passed as a literal value because the Job runs in `jobNamespace`,
     * not the API's namespace, so it cannot `secretKeyRef` the API's own secret.
     */
    databaseUrl: string;
    /**
     * Sentry environment tag for the runner. Injected as an explicit (non-secret)
     * env var, sourced from the launching API's own SENTRY_ENV - so runner errors
     * are tagged with the env that launched them. Replaces the former
     * `previewkit-runner-env` ConfigMap, whose only key this was.
     */
    sentryEnv: string;
    /**
     * Hard upper bound on a deploy Job (seconds). A generous backstop *above*
     * the runner's own internal budgets for three buildkit provisioning,
     * startup, and build attempts plus deployment readiness, so an internal
     * timeout surfaces as a recorded failure rather than an external SIGTERM.
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
 * owns the environment row.
 *
 * The runner image is SHA-pinned and per-environment: it is read from the
 * `previewkit-runner-image` ConfigMap in the API's own namespace (`imageNamespace`),
 * which each env's previewkit deploy writes. The Job itself is created in the
 * shared `previewkit` namespace (`jobNamespace`) with that image baked in, so
 * each environment launches its own runner image into the one preview workload.
 *
 * `DATABASE_URL` is likewise per-environment: the launching API's own DB URL is
 * baked into the Job's env (overriding the shared `previewkit-env-file` secret's
 * production DB URL), so a runner writes its environment/build rows to the same
 * database the launching API reads from.
 *
 * `launchDeploy` / `launchTeardown` / `launchRedeployApp` are the
 * `PreviewkitTriggers` seam consumed by `PreviewkitTriggerService`.
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
        const { event } = params;
        const envKey = previewEnvKey(event.repoFullName, event.prNumber);
        this.logger.info("Launching preview deploy job", {
            extra: { envKey, repo: event.repoFullName, pr: event.prNumber, sha: event.headSha.slice(0, 7) },
        });
        // Resolve the runner image first: a missing image must fail before we
        // supersede the in-flight deploy, so we never kill a running run we
        // cannot replace.
        const image = await this.resolveRunnerImage();
        await this.supersedeDeployFamily(envKey);
        const spec: PreviewJobInput = { mode: "deploy", event };
        await this.createJob("deploy", envKey, event, spec, image, this.deployDeadlineSeconds(), DEPLOY_GRACE_SECONDS);
    }

    async launchRedeployApp(params: TriggerPreviewRedeployAppParams): Promise<void> {
        const { event, namespace, appName, mode } = params;
        const envKey = previewEnvKey(event.repoFullName, event.prNumber);
        this.logger.info("Launching preview per-app redeploy job", {
            extra: { envKey, repo: event.repoFullName, pr: event.prNumber, app: appName, mode },
        });
        const image = await this.resolveRunnerImage();
        // A per-app redeploy supersedes any in-flight deploy/redeploy for the env
        // (shared mutex), exactly like the Temporal redeploy-app workflow.
        await this.supersedeDeployFamily(envKey);
        const spec: PreviewJobInput = {
            mode: "redeploy-app",
            event,
            namespace,
            appName,
            redeployMode: mode,
        };
        await this.createJob(
            "redeploy-app",
            envKey,
            event,
            spec,
            image,
            this.deployDeadlineSeconds(),
            DEPLOY_GRACE_SECONDS,
        );
    }

    async launchTeardown(params: TriggerPreviewTeardownParams): Promise<void> {
        const { event } = params;
        const envKey = previewEnvKey(event.repoFullName, event.prNumber);
        this.logger.info("Launching preview teardown job", {
            extra: { envKey, repo: event.repoFullName, pr: event.prNumber },
        });
        const image = await this.resolveRunnerImage();
        // Teardown supersedes an in-flight deploy/redeploy (same env mutex) but
        // never another teardown - a close-then-reopen lets the deletion finish.
        await this.supersedeDeployFamily(envKey);
        const spec: PreviewJobInput = { mode: "teardown", event };
        await this.createJob(
            "teardown",
            envKey,
            event,
            spec,
            image,
            this.teardownDeadlineSeconds(),
            TEARDOWN_GRACE_SECONDS,
        );
    }

    /**
     * Reads the SHA-pinned runner image the previewkit deploy recorded in the
     * `previewkit-runner-image` ConfigMap. Throws a clear error when it is
     * absent (previewkit not deployed yet) so a launch fails loudly rather than
     * creating an unschedulable Job.
     */
    private async resolveRunnerImage(): Promise<string> {
        const { imageNamespace } = this.options;
        let cm: { data?: Record<string, string> };
        try {
            cm = await this.coreApi.readNamespacedConfigMap({
                name: RUNNER_IMAGE_CONFIGMAP,
                namespace: imageNamespace,
            });
        } catch (err) {
            if (isNotFound(err)) {
                throw new Error(
                    `ConfigMap ${RUNNER_IMAGE_CONFIGMAP} not found in ${imageNamespace} - deploy previewkit before enabling jobs mode`,
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
     * SIGTERMs every in-flight deploy-family Job (deploy + redeploy-app) for an
     * env (Background propagation so the pod is deleted gracefully, triggering
     * the runner's supersede drain). Best-effort: a list/delete failure is
     * logged but never blocks the new launch - newest-wins ownership in the DB
     * tolerates a brief overlap.
     */
    private async supersedeDeployFamily(envKey: string): Promise<void> {
        const { jobNamespace } = this.options;
        const labelSelector = `${LABEL_ENV}=${envKey},${DEPLOY_FAMILY_SELECTOR}`;
        let jobs;
        try {
            jobs = await this.batchApi.listNamespacedJob({ namespace: jobNamespace, labelSelector });
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
                await this.batchApi.deleteNamespacedJob({
                    name,
                    namespace: jobNamespace,
                    propagationPolicy: "Background",
                });
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
        type: JobType,
        envKey: string,
        event: PreviewDeployEvent,
        spec: PreviewJobInput,
        image: string,
        deadlineSeconds: number,
        graceSeconds: number,
    ): Promise<void> {
        const { jobNamespace } = this.options;
        const created = await this.batchApi.createNamespacedJob({
            namespace: jobNamespace,
            body: this.jobSpec(type, envKey, event, spec, image, deadlineSeconds, graceSeconds),
        });
        this.logger.info("Created preview job", { extra: { envKey, type, image, job: created.metadata?.name } });
    }

    private jobSpec(
        type: JobType,
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
                    metadata: {
                        labels,
                        // A runner holds an ephemeral buildkitd Job open for the
                        // whole deploy, so a mid-run node drain (consolidation or
                        // AMI drift) aborts the build and orphans that Job. Opt the
                        // pod out of voluntary disruption; the pool's
                        // terminationGracePeriod still bounds a genuine termination.
                        annotations: { [ANNOTATION_DO_NOT_DISRUPT]: "true" },
                    },
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
                                envFrom: [{ secretRef: { name: RUNNER_ENV_SECRET } }],
                                // Explicit env wins over envFrom on name collision:
                                // DATABASE_URL overrides the production DB URL the
                                // shared previewkit-env-file secret carries, so the
                                // runner writes to the launching API's own DB.
                                // SENTRY_ENV is non-secret runner config sourced from
                                // the launching API (replaces the previewkit-runner-env
                                // ConfigMap) so runner errors are tagged with the env
                                // that launched them.
                                env: [
                                    { name: "PREVIEWKIT_JOB_SPEC", value: JSON.stringify(spec) },
                                    { name: "DATABASE_URL", value: this.options.databaseUrl },
                                    { name: "SENTRY_ENV", value: this.options.sentryEnv },
                                ],
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
        // Three worst-case build attempts can each spend 10 minutes provisioning
        // a node, 3 minutes starting buildkitd, and up to 60 minutes across
        // Railpack preparation plus buildctl. Leave additional room for
        // deployment readiness and cleanup.
        return this.options.deployDeadlineSeconds ?? 270 * 60;
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
