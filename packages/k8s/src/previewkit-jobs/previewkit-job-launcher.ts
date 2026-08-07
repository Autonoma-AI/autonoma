import { createHash } from "node:crypto";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    type PreviewDeployTarget,
    type PreviewJobSpec,
    previewJobSpecSchema,
    type PreviewTeardownTarget,
    type TriggerPreviewRedeployAppParams,
} from "@autonoma/types";
import { ApiException, type V1Job } from "@kubernetes/client-node";

/**
 * The slice of `@kubernetes/client-node`'s `BatchV1Api` the launcher uses.
 * `BatchV1Api` satisfies it structurally, so the launcher depends on this seam
 * (injected) and tests pass a lightweight fake instead of faking a real client.
 */
export interface PreviewJobsApi {
    listNamespacedJob(params: { namespace: string; labelSelector?: string }): Promise<{ items: V1Job[] }>;
    readNamespacedJob(params: { name: string; namespace: string }): Promise<V1Job>;
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

/** Whether a launched Job can still write anything. `gone` is a 404: superseded, cancelled, or TTL-collected. */
export type PreviewDeployJobState = "running" | "succeeded" | "failed" | "gone";

// The "deploy family" - deploy and per-app redeploy share the per-environment
// mutex (the Temporal workflows shared one workflowId), so launching either
// supersedes any in-flight one. Teardown is excluded: a running teardown is
// left to finish (the Jobs equivalent of its nonCancellable scope).
const DEPLOY_FAMILY_SELECTOR = `${LABEL_TYPE} in (deploy,redeploy-app)`;

export interface PreviewkitJobLauncherOptions {
    batchApi: PreviewJobsApi;
    coreApi: ConfigMapReader;
    /** The shared `previewkit` namespace, which holds the SA and env secret the Jobs mount. */
    jobNamespace: string;
    /**
     * The launcher's OWN namespace, where each environment pins its runner image. The resolved image is baked into
     * the spec, so a Job created in `jobNamespace` still runs the launching env's image.
     */
    imageNamespace: string;
    /**
     * Injected literally so the runner writes to the same database the launcher reads. It overrides the shared
     * `previewkit-env-file` secret (always production), and cannot be a `secretKeyRef` because the Job runs in
     * `jobNamespace`, not the launcher's.
     */
    databaseUrl: string;
    /** Per-Job for the same reason as `databaseUrl`: the key it names lives in the database that URL points at. */
    secretsCmk?: string;
    /**
     * This environment's own GitHub App (id + PEM private key, already decoded -
     * this class re-encodes it to base64 for the wire), injected per-Job like
     * `databaseUrl`. Without it, every runner falls back to the production
     * GitHub App the shared `previewkit-env-file` secret carries, which has no
     * installation on repos only a dev/alpha environment's own App was granted
     * access to - deploys then fail cloning with a misleading "not installed"
     * error even though the launching environment's own App connection is fine.
     */
    githubAppId?: string;
    githubAppPrivateKeyPem?: string;
    /** From the launcher's own SENTRY_ENV, so runner errors are tagged with the env that launched them. */
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
 * `previewkit-runner-image` ConfigMap in the launcher's own namespace
 * (`imageNamespace`), which each env's previewkit deploy writes. The Job itself is
 * created in the shared `previewkit` namespace (`jobNamespace`) with that image
 * baked in, so each environment launches its own runner image into the one preview
 * workload.
 *
 * `DATABASE_URL` is likewise per-environment: the launcher's own DB URL is baked
 * into the Job's env (overriding the shared `previewkit-env-file` secret's
 * production DB URL), so a runner writes its environment/build rows to the same
 * database the launcher reads from.
 *
 * The API and the general worker both launch these, on different service accounts (`api` and `worker-general`),
 * so BOTH must be subjects of the `previewkit-job-launcher-ephemeral` RoleBinding and the `configmaps: get` grant.
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

    /**
     * Returns the created Job's name so a caller can cancel exactly the Job it started: the env label is per
     * (repo, PR), so a late label-scoped delete would kill whichever newer commit had already launched.
     */
    async launchDeploy(target: PreviewDeployTarget): Promise<string> {
        const envKey = previewEnvKey(target.repoFullName, target.prNumber);
        this.logger.info("Launching preview deploy job", {
            extra: { envKey, repo: target.repoFullName, pr: target.prNumber, sha: target.headSha.slice(0, 7) },
        });
        // Resolve the runner image first: a missing image must fail before we
        // supersede the in-flight deploy, so we never kill a running run we
        // cannot replace.
        const image = await this.resolveRunnerImage();
        await this.supersedeDeployFamily(envKey);
        const spec: PreviewJobSpec = { mode: "deploy", target };
        return await this.createJob("deploy", envKey, spec, image, this.deployDeadlineSeconds(), DEPLOY_GRACE_SECONDS);
    }

    /**
     * SIGTERM one deploy Job by the name {@link launchDeploy} returned, so an abandoned build drains (aborting
     * buildctl, writing its superseded row) instead of running to completion for a commit nobody will test.
     *
     * A Job already finished or superseded is gone; that 404 is the expected outcome, not a failure.
     */
    async cancelDeploy(jobName: string): Promise<void> {
        const { jobNamespace } = this.options;
        this.logger.info("Cancelling preview deploy job", { extra: { job: jobName } });
        try {
            await this.batchApi.deleteNamespacedJob({
                name: jobName,
                namespace: jobNamespace,
                propagationPolicy: "Background",
            });
        } catch (err) {
            if (isNotFound(err)) {
                this.logger.info("Preview deploy job was already gone", { extra: { job: jobName } });
                return;
            }
            throw err;
        }
    }

    /** A runner that declines exits 0 having written no row, so only the Job separates "not yet" from "never". */
    async getDeployJobState(jobName: string): Promise<PreviewDeployJobState> {
        const { jobNamespace } = this.options;
        let job: V1Job;
        try {
            job = await this.batchApi.readNamespacedJob({ name: jobName, namespace: jobNamespace });
        } catch (err) {
            if (isNotFound(err)) {
                this.logger.info("Preview deploy job no longer exists", { extra: { job: jobName } });
                return "gone";
            }
            throw err;
        }

        const state = deployJobState(job);
        this.logger.info("Read preview deploy job state", { extra: { job: jobName, state } });
        return state;
    }

    async launchRedeployApp(params: TriggerPreviewRedeployAppParams): Promise<void> {
        const { target, namespace, appName, mode } = params;
        const envKey = previewEnvKey(target.repoFullName, target.prNumber);
        this.logger.info("Launching preview per-app redeploy job", {
            extra: { envKey, repo: target.repoFullName, pr: target.prNumber, app: appName, mode },
        });
        const image = await this.resolveRunnerImage();
        // A per-app redeploy supersedes any in-flight deploy/redeploy for the env
        // (shared mutex), exactly like the Temporal redeploy-app workflow.
        await this.supersedeDeployFamily(envKey);
        const spec: PreviewJobSpec = {
            mode: "redeploy-app",
            target,
            namespace,
            appName,
            redeployMode: mode,
        };
        await this.createJob("redeploy-app", envKey, spec, image, this.deployDeadlineSeconds(), DEPLOY_GRACE_SECONDS);
    }

    async launchTeardown(target: PreviewTeardownTarget): Promise<void> {
        const envKey = previewEnvKey(target.repoFullName, target.prNumber);
        this.logger.info("Launching preview teardown job", {
            extra: { envKey, repo: target.repoFullName, pr: target.prNumber },
        });
        const image = await this.resolveRunnerImage();
        // Teardown supersedes an in-flight deploy/redeploy (same env mutex) but
        // never another teardown - a close-then-reopen lets the deletion finish.
        await this.supersedeDeployFamily(envKey);
        const spec: PreviewJobSpec = { mode: "teardown", target };
        await this.createJob("teardown", envKey, spec, image, this.teardownDeadlineSeconds(), TEARDOWN_GRACE_SECONDS);
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

    /** Returns the name the server assigns from `generateName`. */
    private async createJob(
        type: JobType,
        envKey: string,
        spec: PreviewJobSpec,
        image: string,
        deadlineSeconds: number,
        graceSeconds: number,
    ): Promise<string> {
        const { jobNamespace } = this.options;
        const created = await this.batchApi.createNamespacedJob({
            namespace: jobNamespace,
            body: this.jobSpec(type, envKey, spec, image, deadlineSeconds, graceSeconds),
        });
        const name = created.metadata?.name;
        this.logger.info("Created preview job", { extra: { envKey, type, image, job: name } });
        if (name == null) {
            throw new Error(`Kubernetes accepted the ${type} Job for ${envKey} but returned no name`);
        }
        return name;
    }

    private jobSpec(
        type: JobType,
        envKey: string,
        spec: PreviewJobSpec,
        image: string,
        deadlineSeconds: number,
        graceSeconds: number,
    ): V1Job {
        const { target } = spec;
        const labels = {
            [LABEL_MANAGED_BY]: "previewkit",
            [LABEL_TYPE]: type,
            [LABEL_ENV]: envKey,
            [LABEL_PR]: String(target.prNumber),
        };

        // Explicit env wins over envFrom on name collision: DATABASE_URL overrides the production value the
        // shared previewkit-env-file secret carries, so the runner writes to the launcher's own DB. SENTRY_ENV is
        // non-secret runner config.
        const runnerEnv = [
            { name: "PREVIEWKIT_JOB_SPEC", value: JSON.stringify(previewJobSpecSchema.parse(spec)) },
            { name: "DATABASE_URL", value: this.options.databaseUrl },
            { name: "SENTRY_ENV", value: this.options.sentryEnv },
        ];
        if (this.options.secretsCmk != null) {
            runnerEnv.push({ name: "PREVIEWKIT_SECRETS_CMK", value: this.options.secretsCmk });
        }
        if (this.options.githubAppId != null) {
            runnerEnv.push({ name: "GITHUB_APP_ID", value: this.options.githubAppId });
        }
        if (this.options.githubAppPrivateKeyPem != null) {
            // The runner's own env schema expects base64-encoded PEM (see
            // packages/github/src/schemas.ts base64PrivateKey) and decodes it at
            // boot; re-encode the already-decoded PEM we were given to match.
            runnerEnv.push({
                name: "GITHUB_PRIVATE_KEY",
                value: Buffer.from(this.options.githubAppPrivateKeyPem, "utf8").toString("base64"),
            });
        }

        return {
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: {
                generateName: `pk-${type}-${nameSlug(target.repoFullName, NAME_SLUG_MAX)}-${target.prNumber}-`,
                labels,
                annotations: headShaAnnotation(target),
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
                                env: runnerEnv,
                                // Guaranteed QoS (requests == limits) rather than the prior Burstable
                                // 500m/1Gi request with an unbounded-in-practice 4Gi memory limit and no
                                // CPU limit. Sized from 7d of measured usage across ~7k runner pods
                                // (2026-08): CPU p99 230m/max 292m, memory p99 491Mi/max 815Mi. 500m CPU
                                // avoids CFS throttling during a build's CPU-heavier phase; 1Gi memory is
                                // a real ceiling (~26% headroom above the largest run observed) instead
                                // of one so large it never protected anything.
                                resources: {
                                    requests: { cpu: "500m", memory: "1Gi" },
                                    limits: { cpu: "500m", memory: "1Gi" },
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

/**
 * The conditions decide, not `status.failed`: with `backoffLimit: 1` a first pod failure leaves that at 1 while the
 * retry is still pending. `succeeded` is read too, because it is set a moment before the `Complete` condition.
 */
function deployJobState(job: V1Job): PreviewDeployJobState {
    const conditions = job.status?.conditions ?? [];
    const isTrue = (type: string): boolean =>
        conditions.some((condition) => condition.type === type && condition.status === "True");

    if (isTrue("Complete") || (job.status?.succeeded ?? 0) > 0) return "succeeded";
    if (isTrue("Failed")) return "failed";
    return "running";
}

/** A teardown target has no sha until the runner resolves one from the environment row. */
function headShaAnnotation(target: PreviewJobSpec["target"]): Record<string, string> {
    const annotations: Record<string, string> = { [ANNOTATION_REPO]: target.repoFullName };
    if (target.headSha != null) annotations[ANNOTATION_HEAD_SHA] = target.headSha;
    return annotations;
}
