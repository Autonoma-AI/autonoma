import { randomUUID, randomBytes } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import type { AppConfig, PreviewConfig } from "../config/schema";
import { logger } from "../logger";
import { computeDeployWaves } from "../pipeline/deploy-graph";
import { parsePostgresOptions } from "../recipes/postgres-recipe";
import type { RecipeResources } from "../recipes/recipe";
import { RecipeRegistry } from "../recipes/recipe-registry";
import type { AppSecretInfo, AwsExternalSecretManager } from "../secrets/aws-external-secret-manager";
import { type AddonOutputs, EnvInjector } from "./env-injector";
import { mirrorDockerHubImage } from "./image-mirror";
import { isConflict, isNotFound } from "./k8s-errors";
import { type GatekeeperRoute, NamespaceManager, type NamespaceAnnotations } from "./namespace-manager";
import { buildNetworkPolicies } from "./network-policy-factory";
import { findTerminalPodFailure, summarizePodStates } from "./pod-failure";
import { PostgresRestorer } from "./postgres-restorer";
import {
    buildAppDeployment,
    buildAppHostname,
    buildAppService,
    buildCentralGatekeeperRole,
    buildCentralGatekeeperRoleBinding,
} from "./resource-factory";

/** ConfigMap name marking that a database's one-time setup already ran. */
function setupMarkerName(service: string): string {
    return `previewkit-db-setup-${service}`;
}

/**
 * Per-app outcome of the deploy phase. Apps are deployed independently — one
 * app's failure does not abort the others.
 *
 * - `ok`: Deployment, Service, HTTPRoute applied and the Deployment reported
 *   ready. `url` is set.
 * - `failed`: K8s apply or readiness wait threw. `url` is still set because
 *   the DNS host is computed from the app name and may resolve to a partially
 *   applied resource (commonly serving 502). `crashLoopBackOff` is true when
 *   the failure was specifically CrashLoopBackOff — these pods may recover
 *   after post_deploy hooks run migrations.
 * - `skipped`: deployer was not given an imageTag for this app (its build
 *   failed upstream), so no K8s resources were applied at all.
 */
export type AppDeployOutcome =
    | { status: "ok"; url: string }
    | { status: "failed"; url: string; error: string; crashLoopBackOff?: boolean }
    | { status: "skipped"; reason: string };

export interface DeployResult {
    namespace: string;
    urls: Record<string, string>;
    appOutcomes: Record<string, AppDeployOutcome>;
    bypassToken: string;
}

/**
 * Result of the infra-only phase (namespace + services). Passed into
 * `deployApps` so the pipeline can insert pre-deploy hooks between the two
 * phases (e.g. create Postgres schemas after the DB is up, before app pods start).
 */
export interface InfraDeployResult {
    namespace: string;
    awsSecretsByApp: Map<string, AppSecretInfo>;
    bypassToken: string;
}

interface AppDeployContext {
    namespace: string;
    prNumber: number;
    owner: string;
    repoFullName: string;
    domain: string;
    secret: string;
    config: PreviewConfig;
    headSha: string;
    imageTags: Record<string, string>;
    awsSecretsByApp: Map<string, AppSecretInfo>;
    addonOutputs: AddonOutputs;
}

export interface DeployOptions {
    repoFullName: string;
    prNumber: number;
    headSha: string;
    organizationId: string;
    // GitHub-side numeric repo id. Used to find the Application row for
    // Application-scoped resources (e.g. AWS Secrets Manager registrations).
    githubRepositoryId: number;
    config: PreviewConfig;
    imageTags: Record<string, string>;
    addonOutputs?: AddonOutputs;
    commentId?: string;
}

export class Deployer {
    private coreApi: k8s.CoreV1Api;
    private appsApi: k8s.AppsV1Api;
    private networkingApi: k8s.NetworkingV1Api;
    private rbacApi: k8s.RbacAuthorizationV1Api;
    private namespaceManager: NamespaceManager;
    private envInjector: EnvInjector;
    private recipeRegistry: RecipeRegistry;

    constructor(
        private kc: k8s.KubeConfig,
        private domain: string,
        private secret: string,
        private awsExternalSecretManager?: AwsExternalSecretManager,
        // Shared edge namespace: the Gateway, ingress-nginx, AND the central
        // Gatekeeper live in `system`, which is also the NetworkPolicy ingress
        // source allowed to reach preview pods - so the central Gatekeeper's
        // cross-namespace proxying needs no extra allowance.
        private ingressNamespace: string = "system",
        private deployTimeoutMs: number = 600_000,
        // Written per namespace as the gatekeeper.dev/idle-timeout annotation;
        // overrides the central install's cluster-wide IDLE_TIMEOUT default.
        private idleTimeout: string = "30m",
        // Docker Hub pull-through cache prefix (see DOCKER_HUB_MIRROR in env.ts).
        // Applied to every platform-managed image: service recipes and the nginx
        // proxy. Client app images come from our own registry and are never touched.
        private dockerHubMirrorUrl: string = "",
    ) {
        this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
        this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
        this.networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
        this.rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
        this.namespaceManager = new NamespaceManager(kc);
        this.recipeRegistry = new RecipeRegistry();
        this.envInjector = new EnvInjector(this.recipeRegistry);
    }

    /**
     * Full deploy: infra (services) + apps. Convenience wrapper for callers
     * that do not need to insert steps between the two phases.
     */
    async deploy(opts: DeployOptions): Promise<DeployResult> {
        const infraResult = await this.deployInfra(opts);
        return this.deployApps(opts, infraResult);
    }

    /**
     * Phase 1: namespace, network policies, external secrets, service recipes,
     * and service readiness wait. Returns an `InfraDeployResult` that must be
     * passed to `deployApps` to complete the deployment.
     *
     * Splitting here lets the pipeline run pre-deploy hooks (e.g. Postgres
     * schema creation) after services are up but before any app pod starts,
     * which avoids CrashLoopBackOff caused by missing schemas.
     */
    async deployInfra(opts: DeployOptions): Promise<InfraDeployResult> {
        const { repoFullName, prNumber, headSha, organizationId, githubRepositoryId, config, commentId } = opts;

        // Reuse the existing bypass token across redeployments so PR comment
        // access links stay valid. Only generate a new token for brand-new environments.
        const existingNamespace = this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
        const existingAnnotations = await this.namespaceManager.getAnnotations(existingNamespace);
        const bypassToken = existingAnnotations?.bypassToken ?? randomBytes(32).toString("hex");

        // 1. Create namespace
        const namespace = await this.namespaceManager.create(repoFullName, prNumber, organizationId, {
            commentId,
            lastDeployedSha: headSha,
            bypassToken,
        });

        logger.info("Deploying preview environment", { namespace, prNumber, organizationId });

        // 2. Apply NetworkPolicies for tenant isolation before any workload runs
        await this.applyNetworkPolicies(namespace, organizationId);

        // 3. Apply ExternalSecrets for this Application's AWS Secrets Manager registrations
        const appNames = config.apps.map((a) => a.name);
        const awsSecretsByApp =
            this.awsExternalSecretManager != null
                ? await this.awsExternalSecretManager.applyForNamespace(
                      organizationId,
                      githubRepositoryId,
                      namespace,
                      appNames,
                  )
                : new Map<string, AppSecretInfo>();

        // 4. Deploy service recipes (postgres, redis, etc.)
        for (const svcConfig of config.services) {
            const recipe = this.recipeRegistry.get(svcConfig.recipe);
            const resources = recipe.generate(svcConfig, namespace);
            this.mirrorRecipeImages(resources);

            for (const pvc of resources.persistentVolumeClaims) {
                await this.applyPvc(namespace, pvc);
            }
            for (const cm of resources.configMaps) {
                await this.applyCoreResource(namespace, cm, "configmaps");
            }
            for (const ss of resources.statefulSets) {
                await this.applyStatefulSet(namespace, ss);
            }
            for (const dep of resources.deployments) {
                await this.applyServiceDeployment(namespace, dep);
            }
            for (const svc of resources.services) {
                await this.applyService(namespace, svc);
            }

            logger.info("Deployed service recipe", { service: svcConfig.name, recipe: svcConfig.recipe, namespace });
        }

        // 5. Delete any crashed service pods so the controller creates fresh ones
        for (const svcConfig of config.services) {
            await this.deleteCrashedPods(namespace, svcConfig.name);
        }

        // 6. Wait for service readiness
        await this.waitForServicesReady(namespace, config);

        // 6.5 Restore postgres from backup if configured (runs before apps boot)
        await this.restorePostgresDatabases(namespace, config);

        // 7. Hand the namespace to the CENTRAL Gatekeeper (cluster mode): the
        //    gatekeeper.dev/managed label + routes annotation on the Namespace
        //    are the whole contract - the shared install in `system`
        //    (deployment/previewkit/cluster/gatekeeper/) discovers them within
        //    milliseconds and the wildcard Ingress there carries every preview
        //    host, so no per-namespace proxy or per-app Ingress is stamped.
        const domain = config.domain ?? this.domain;
        const routes: Record<string, GatekeeperRoute> = {};
        for (const app of config.apps) {
            routes[buildAppHostname(app.name, prNumber, repoFullName, domain, this.secret)] = {
                service: app.name,
                port: app.port,
            };
        }
        // Grant the central Gatekeeper's ServiceAccount workload access HERE,
        // namespaced, BEFORE the label makes it discover the namespace: RBAC
        // cannot scope to label selectors, so its ClusterRole carries no
        // workload verbs and this per-namespace Role is the only thing letting
        // it sleep/wake this preview - and nothing else in the cluster.
        await this.applyRole(namespace, buildCentralGatekeeperRole(namespace, prNumber));
        await this.applyRoleBinding(
            namespace,
            buildCentralGatekeeperRoleBinding(namespace, this.ingressNamespace, prNumber),
        );
        await this.namespaceManager.ensureGatekeeperManagement(namespace, routes, this.idleTimeout);
        // Previews created before cluster mode still carry an in-namespace
        // gatekeeper + per-app Ingresses. Their one-time removal is NOT done
        // here - it lives in deployment/previewkit/cluster/gatekeeper/
        // migrate-existing-previews.sh, run once (and re-run for stragglers)
        // during rollout. The sweep and this handoff must be atomic per
        // namespace (else the central gatekeeper sees no traffic and sleeps a
        // namespace the old one is serving), so the script does BOTH together;
        // run it promptly after shipping this so no existing preview is
        // redeployed into that half-migrated state. Brand-new namespaces have
        // no old footprint, so this handoff alone fully sets them up.

        // 7. Deploy apps wave by wave; apps within each wave are deployed in parallel.
        //    Each app is its own failure domain — one app's failure (build skip
        //    or K8s apply error) does not stop other apps from deploying. Wave
        //    ordering is preserved purely as a hint: depends_on still controls
        //    *when* an app is attempted, but a downstream app is attempted even
        //    if its upstream failed (the user prefers a partial preview over
        //    none — see the per-app independence design discussion).
        return { namespace, awsSecretsByApp, bypassToken };
    }

    /**
     * Phase 2: deploy app images wave by wave. Accepts the `InfraDeployResult`
     * from `deployInfra`. Each app is its own failure domain — one app's
     * failure (build skip or K8s apply error) does not stop other apps.
     */
    async deployApps(opts: DeployOptions, infraResult: InfraDeployResult): Promise<DeployResult> {
        const { repoFullName, prNumber, headSha, config, imageTags, addonOutputs = {} } = opts;
        const { namespace, awsSecretsByApp, bypassToken } = infraResult;
        const domain = config.domain ?? this.domain;

        const owner = repoFullName.split("/")[0]!;
        const urls: Record<string, string> = {};
        const appOutcomes: Record<string, AppDeployOutcome> = {};

        const appCtx: AppDeployContext = {
            namespace,
            prNumber,
            owner,
            repoFullName,
            domain,
            secret: this.secret,
            config,
            headSha,
            imageTags,
            awsSecretsByApp,
            addonOutputs,
        };

        const waves = computeDeployWaves(config.apps);
        for (const wave of waves) {
            logger.info("Deploying wave", { namespace, apps: wave.map((a) => a.name) });
            const settled = await Promise.allSettled(wave.map((app) => this.tryDeployApp(app, appCtx)));
            for (let i = 0; i < wave.length; i++) {
                const app = wave[i]!;
                const result = settled[i]!;
                // tryDeployApp never rejects — it converts thrown errors into a
                // structured outcome. Treating an `allSettled` rejection here as
                // possible would just be defensive paranoia.
                if (result.status !== "fulfilled") {
                    logger.error("tryDeployApp unexpectedly rejected — treating as failed", result.reason, {
                        namespace,
                        app: app.name,
                    });
                    const url = `https://${buildAppHostname(app.name, prNumber, repoFullName, domain, this.secret)}`;
                    appOutcomes[app.name] = {
                        status: "failed",
                        url,
                        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                    };
                    urls[app.name] = url;
                    continue;
                }
                const outcome = result.value;
                appOutcomes[app.name] = outcome;
                if (outcome.status !== "skipped") {
                    urls[app.name] = outcome.url;
                }
            }
        }

        return { namespace, urls, appOutcomes, bypassToken };
    }

    /**
     * Deploys exactly ONE app (per-app redeploy, rebuild mode), leaving siblings
     * untouched. Assumes infra and the app's dependencies are already up, so it
     * bypasses `computeDeployWaves` - a single app is its own wave, and feeding a
     * one-element list with `depends_on` to the wave planner would throw on the
     * missing upstream. The full merged `config` is still passed so env-template
     * resolution can reference sibling hosts/services.
     */
    async deploySingleApp(opts: DeployOptions, infraResult: InfraDeployResult, appName: string): Promise<DeployResult> {
        const { repoFullName, prNumber, headSha, config, imageTags, addonOutputs = {} } = opts;
        const { namespace, awsSecretsByApp, bypassToken } = infraResult;
        const domain = config.domain ?? this.domain;
        const owner = repoFullName.split("/")[0]!;

        const app = config.apps.find((a) => a.name === appName);
        if (app == null) {
            throw new Error(`App "${appName}" not found in resolved config for ${namespace}`);
        }

        const appCtx: AppDeployContext = {
            namespace,
            prNumber,
            owner,
            repoFullName,
            domain,
            secret: this.secret,
            config,
            headSha,
            imageTags,
            awsSecretsByApp,
            addonOutputs,
        };

        logger.info("Deploying single app", { namespace, app: appName });
        const outcome = await this.tryDeployApp(app, appCtx);

        const urls: Record<string, string> = {};
        if (outcome.status !== "skipped") urls[app.name] = outcome.url;
        return { namespace, urls, appOutcomes: { [app.name]: outcome }, bypassToken };
    }

    /**
     * Wraps `deployApp` with per-app error capture. Returns a structured outcome
     * instead of throwing so the wave loop can keep going for the remaining apps.
     */
    private async tryDeployApp(app: AppConfig, ctx: AppDeployContext): Promise<AppDeployOutcome> {
        const imageTag = ctx.imageTags[app.name];
        if (imageTag == null || imageTag === "") {
            logger.info("Skipping app deploy: no image tag (build failed upstream)", {
                namespace: ctx.namespace,
                app: app.name,
            });
            return { status: "skipped", reason: "build failed" };
        }

        try {
            const { url } = await this.deployApp(app, ctx);
            return { status: "ok", url };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error("App deploy failed", err, { namespace: ctx.namespace, app: app.name });
            const url = `https://${buildAppHostname(app.name, ctx.prNumber, ctx.repoFullName, ctx.domain, ctx.secret)}`;
            const crashLoopBackOff = message.includes("CrashLoopBackOff");
            return { status: "failed", url, error: message, crashLoopBackOff };
        }
    }

    /**
     * For each app that ended in CrashLoopBackOff, deletes its crashing pods
     * (bypassing exponential backoff) then waits for the Deployment to become
     * Ready. Called after post_deploy hooks so that migrations applied during
     * post_deploy are in place before the pods restart.
     *
     * Returns updated outcomes keyed by app name. Apps that do not recover
     * within `timeoutMs` stay `failed`.
     */
    async restartCrashedApps(
        namespace: string,
        crashedApps: Array<{ name: string; url: string }>,
        timeoutMs = 120_000,
    ): Promise<Record<string, AppDeployOutcome>> {
        const results: Record<string, AppDeployOutcome> = {};
        for (const { name, url } of crashedApps) {
            logger.info("Restarting crash-looped app after post_deploy hooks", { namespace, app: name });
            try {
                await this.deleteCrashedPods(namespace, name);
                await this.waitForDeploymentReady(namespace, name, timeoutMs);
                results[name] = { status: "ok", url };
                logger.info("App recovered after post_deploy restart", { namespace, app: name });
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                logger.warn("App did not recover after post_deploy restart", { namespace, app: name, error });
                results[name] = { status: "failed", url, error };
            }
        }
        return results;
    }

    /**
     * Re-rolls a single app's pods (per-app redeploy, restart mode) by deleting
     * them so the Deployment controller recreates them with freshly-read
     * ConfigMaps and Secrets, then waits for the Deployment to be ready again.
     * The Deployment spec is untouched (no rebuild, same image) - this is the
     * way to pick up a changed secret/env without a new image. An app scaled to
     * zero (Gatekeeper idle) has no pods and is already "ready", so this is a
     * no-op for it (it reads fresh config on its next wake).
     */
    async restartApp(
        namespace: string,
        appName: string,
        signal?: AbortSignal,
        timeoutMs = this.deployTimeoutMs,
    ): Promise<void> {
        logger.info("Restarting app pods", { namespace, app: appName });
        signal?.throwIfAborted();
        const pods = await this.coreApi.listNamespacedPod({ namespace, labelSelector: `app=${appName}` });

        // Track deletions so we never report a successful restart when nothing was
        // re-rolled. A pod-less Deployment (Gatekeeper-idle, scaled to zero) is a
        // legitimate no-op, but if pods exist and every delete fails the old pods
        // keep serving stale config - that must surface as a failure, not success.
        let attempted = 0;
        let deleted = 0;
        const deleteErrors: string[] = [];
        for (const pod of pods.items) {
            const podName = pod.metadata?.name;
            if (podName == null) continue;
            signal?.throwIfAborted();
            attempted += 1;
            try {
                await this.coreApi.deleteNamespacedPod({ namespace, name: podName });
                deleted += 1;
                logger.info("Deleted pod for app restart", { namespace, app: appName, pod: podName });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                deleteErrors.push(`${podName}: ${message}`);
                logger.warn("Failed to delete pod during app restart", { namespace, app: appName, pod: podName, err });
            }
        }

        if (attempted > 0 && deleted === 0) {
            throw new Error(
                `Failed to restart "${appName}" in ${namespace}: no pods deleted (${deleteErrors.join("; ")})`,
            );
        }

        signal?.throwIfAborted();
        await this.waitForDeploymentReady(namespace, appName, timeoutMs);
        logger.info("App restart complete", { namespace, app: appName, attempted, deleted });
    }

    private async deleteCrashedPods(namespace: string, appName: string): Promise<void> {
        const pods = await this.coreApi.listNamespacedPod({
            namespace,
            labelSelector: `app=${appName}`,
        });
        for (const pod of pods.items) {
            const podName = pod.metadata?.name;
            if (podName == null) continue;
            const isCrashing = pod.status?.containerStatuses?.some(
                (cs) => cs.state?.waiting?.reason === "CrashLoopBackOff",
            );
            if (isCrashing) {
                await this.coreApi.deleteNamespacedPod({ namespace, name: podName }).catch(() => {});
                logger.info("Deleted CrashLoopBackOff pod for post_deploy recovery", {
                    namespace,
                    app: appName,
                    pod: podName,
                });
            }
        }
    }

    async teardown(repoFullName: string, prNumber: number): Promise<void> {
        const namespace = this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
        await this.namespaceManager.delete(namespace);
    }

    getNamespaceName(repoFullName: string, prNumber: number): string {
        return this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
    }

    /**
     * For each postgres service that declares `options.restore_from`, download
     * the backup from S3 and restore it into the preview database. Runs after
     * services are ready but before apps are deployed so apps boot on seeded data.
     */
    private async restorePostgresDatabases(namespace: string, config: PreviewConfig): Promise<void> {
        for (const svc of config.services) {
            if (svc.recipe !== "postgres") continue;

            const options = parsePostgresOptions(svc);
            if (options.restore_from == null) continue;

            const restorer = new PostgresRestorer(this.kc, namespace);
            await restorer.restore({
                serviceName: svc.name,
                bucket: options.restore_from.bucket,
                key: options.restore_from.key,
                region: options.restore_from.region,
                dbUser: options.user,
                dbName: options.database,
            });
        }
    }

    getKubeConfig(): k8s.KubeConfig {
        return this.kc;
    }

    /** Default preview domain (taken from env at construction time). The
     *  pipeline applies the same `config.domain ?? deployer.getDomain()`
     *  priority used internally before computing public URLs. */
    getDomain(): string {
        return this.domain;
    }

    /** HMAC key for URL generation. Exposed so the pipeline can build
     *  PublicUrlInfo for build_args templating before any deployer call. */
    getSecret(): string {
        return this.secret;
    }

    /** Exposed so the pipeline can template `build_args` (which run BEFORE
     *  any deployer call) using the same `{{name.host/port/url}}` grammar
     *  the deployer applies to runtime env. */
    getEnvInjector(): EnvInjector {
        return this.envInjector;
    }

    /**
     * Whether a database's one-time (`on_create`) setup has already run in this
     * namespace, tracked by a marker ConfigMap. The namespace - and the marker -
     * is deleted on teardown, so a reopened PR's fresh database re-runs on-create
     * setup. Redeploys of the same open PR keep the marker (and the PVC), so
     * on-create setup runs exactly once per database lifetime.
     */
    async databaseSetupHasRun(namespace: string, service: string): Promise<boolean> {
        try {
            await this.coreApi.readNamespacedConfigMap({ namespace, name: setupMarkerName(service) });
            return true;
        } catch (err) {
            if (isNotFound(err)) return false;
            throw err;
        }
    }

    /** Records that a database's one-time setup completed (see {@link databaseSetupHasRun}). */
    async markDatabaseSetupComplete(namespace: string, service: string): Promise<void> {
        const body: k8s.V1ConfigMap = {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: {
                name: setupMarkerName(service),
                namespace,
                labels: { "previewkit.dev/managed-by": "previewkit", "previewkit.dev/service": service },
            },
            data: { service },
        };
        try {
            await this.coreApi.createNamespacedConfigMap({ namespace, body });
        } catch (err) {
            // A racing redeploy may have created it first - the marker is what
            // matters, not who wrote it.
            if (!isConflict(err)) throw err;
        }
    }

    async getNamespaceAnnotations(repoFullName: string, prNumber: number) {
        const namespace = this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
        return this.namespaceManager.getAnnotations(namespace);
    }

    /** Returns true iff the K8s namespace for this (repo, pr) currently
     *  exists in the cluster. Distinguishes NotFound (returns false) from
     *  transient API errors (throws), so callers can safely use this as a
     *  precondition before destructive actions. */
    async namespaceExists(repoFullName: string, prNumber: number): Promise<boolean> {
        const namespace = this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
        return this.namespaceManager.exists(namespace);
    }

    async ensureNamespace(
        repoFullName: string,
        prNumber: number,
        organizationId: string,
        annotations?: NamespaceAnnotations,
    ): Promise<string> {
        const namespace = await this.namespaceManager.create(repoFullName, prNumber, organizationId, annotations);
        await this.applyNetworkPolicies(namespace, organizationId);
        return namespace;
    }

    async updateStatus(repoFullName: string, prNumber: number, annotations: NamespaceAnnotations): Promise<void> {
        const namespace = this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
        await this.namespaceManager.updateAnnotations(namespace, annotations);
    }

    private async deployApp(app: AppConfig, opts: AppDeployContext): Promise<{ name: string; url: string }> {
        const {
            namespace,
            prNumber,
            owner,
            repoFullName,
            domain,
            secret,
            config,
            headSha,
            imageTags,
            awsSecretsByApp,
            addonOutputs,
        } = opts;

        const imageTag = imageTags[app.name];
        if (imageTag == null) {
            throw new Error(`No image tag found for app "${app.name}"`);
        }

        const templateContext = { pr: String(prNumber), namespace, owner };
        const publicUrlInfo = { domain, repoFullName, prNumber, secret };
        const host = buildAppHostname(app.name, prNumber, repoFullName, domain, secret);
        const url = `https://${host}`;
        const resolvedEnv = this.envInjector.resolveConnections(
            app.connections,
            config.apps,
            config.services,
            namespace,
            templateContext,
            publicUrlInfo,
            addonOutputs,
        );

        const secretInfo = awsSecretsByApp.get(app.name);
        const deployment = buildAppDeployment({
            app,
            namespace,
            imageTag,
            resolvedEnv,
            prNumber,
            publicUrl: url,
            awsSecretName: secretInfo?.secretName,
            secretVersion: secretInfo?.secretVersion,
            headSha,
        });
        const service = buildAppService({ app, namespace, imageTag, resolvedEnv, prNumber, publicUrl: url, headSha });

        await this.applyDeployment(namespace, deployment);
        await this.applyService(namespace, service);

        await this.waitForDeploymentReady(namespace, app.name);

        logger.info("Deployed app", { app: app.name, url, namespace });
        return { name: app.name, url };
    }

    private async waitForDeploymentReady(
        namespace: string,
        appName: string,
        timeoutMs = this.deployTimeoutMs,
    ): Promise<void> {
        const start = Date.now();
        logger.info("Waiting for deployment to be ready", { namespace, app: appName });
        const labelSelector = `app=${appName}`;

        while (Date.now() - start < timeoutMs) {
            if (await this.isDeploymentAvailable(namespace, appName)) {
                logger.info("Deployment ready", { namespace, app: appName });
                return;
            }

            // Fail fast on a terminal pod state (bad image, crash loop, bad
            // config). It will never become available within the timeout, and the
            // precise reason is far more actionable than a generic "timed out".
            // The reason string keeps the literal k8s reason so tryDeployApp can
            // still detect CrashLoopBackOff - the one failure the post_deploy
            // recovery retries.
            const failure = findTerminalPodFailure(await this.listPodsQuietly(namespace, labelSelector));
            if (failure != null) {
                logger.warn("Deployment hit a terminal pod state, failing fast", { namespace, app: appName, failure });
                throw new Error(`Deployment "${appName}" will not become ready: ${failure}`);
            }

            await new Promise((r) => setTimeout(r, 3000));
        }

        const pods = summarizePodStates(await this.listPodsQuietly(namespace, labelSelector));
        logger.error("Timed out waiting for deployment to be ready", { namespace, app: appName, pods });
        throw new Error(`Timed out waiting for deployment "${appName}" to be ready in ${namespace}; pods: ${pods}`);
    }

    /**
     * Reads the Deployment and reports whether its current generation is fully
     * rolled out and available. Transient API errors are logged and reported as
     * "not ready" so the readiness loop keeps polling.
     */
    private async isDeploymentAvailable(namespace: string, appName: string): Promise<boolean> {
        try {
            const res = await this.appsApi.readNamespacedDeployment({ namespace, name: appName });
            const { metadata, spec, status } = res;
            const desired = spec?.replicas ?? 1;
            const generation = metadata?.generation ?? 0;
            const observed = status?.observedGeneration ?? 0;
            const updated = status?.updatedReplicas ?? 0;
            const available = status?.availableReplicas ?? 0;
            return observed >= generation && updated >= desired && available >= desired;
        } catch (err) {
            logger.warn("Transient error polling deployment status, retrying", { namespace, app: appName, err });
            return false;
        }
    }

    /**
     * Lists the pods for a label selector, returning [] on error. The readiness
     * loops treat "could not read pods" as "keep waiting", never as a terminal
     * failure, so a flaky API call can't fail a deploy on its own.
     */
    private async listPodsQuietly(namespace: string, labelSelector: string): Promise<k8s.V1Pod[]> {
        try {
            const res = await this.coreApi.listNamespacedPod({ namespace, labelSelector });
            return res.items;
        } catch (err) {
            logger.warn("Could not list pods for readiness check", { namespace, labelSelector, err });
            return [];
        }
    }

    private async waitForServicesReady(
        namespace: string,
        config: PreviewConfig,
        timeoutMs = this.deployTimeoutMs,
    ): Promise<void> {
        if (config.services.length === 0) return;

        // Only wait on services that actually generated a K8s Service resource.
        // Connector-style recipes can intentionally return no resources — there's
        // no Endpoints object to poll for them, and waiting would hang forever.
        const serviceNames = config.services
            .filter((svc) => this.recipeRegistry.get(svc.recipe).generate(svc, namespace).services.length > 0)
            .map((svc) => svc.name);

        if (serviceNames.length === 0) {
            logger.info("No deployable services to wait on; skipping readiness check", { namespace });
            return;
        }

        const start = Date.now();
        logger.info("Waiting for services to be ready", { namespace, services: serviceNames });

        const notReadyServices = new Set<string>();

        while (Date.now() - start < timeoutMs) {
            const pending = await this.findPendingServices(namespace, serviceNames, notReadyServices);

            if (pending.length === 0) {
                logger.info("All services ready", { namespace });
                return;
            }

            // Fail fast if a not-yet-ready service has a pod in a terminal state.
            // A misconfigured recipe image or a crash-looping dependency won't
            // recover by waiting, so surface the reason now instead of after the
            // full timeout.
            for (const name of pending) {
                const failure = findTerminalPodFailure(await this.listPodsQuietly(namespace, `app=${name}`));
                if (failure != null) {
                    logger.error("Service hit a terminal pod state, failing fast", {
                        namespace,
                        service: name,
                        failure,
                    });
                    throw new Error(`Service "${name}" will not become ready: ${failure}`);
                }
            }

            await new Promise((r) => setTimeout(r, 5000));
        }

        // Log pod status for every service before throwing, to explain the timeout.
        for (const name of serviceNames) {
            const pods = summarizePodStates(await this.listPodsQuietly(namespace, `app=${name}`));
            logger.error("Service pods not ready at timeout", { namespace, service: name, pods });
        }

        throw new Error(`Timed out waiting for services to be ready in ${namespace}`);
    }

    /**
     * Returns the services whose Endpoints have no ready addresses yet, logging
     * each not-ready / became-ready transition once via `notReadyServices`.
     */
    private async findPendingServices(
        namespace: string,
        serviceNames: string[],
        notReadyServices: Set<string>,
    ): Promise<string[]> {
        const pending: string[] = [];
        for (const name of serviceNames) {
            if (await this.serviceHasReadyEndpoints(namespace, name)) {
                if (notReadyServices.delete(name)) {
                    logger.info("Service became ready", { namespace, service: name });
                }
                continue;
            }
            pending.push(name);
            if (!notReadyServices.has(name)) {
                notReadyServices.add(name);
                logger.info("Service not ready yet", { namespace, service: name });
            }
        }
        return pending;
    }

    /**
     * Whether a Service has at least one ready backend address. Endpoint query
     * errors are logged and treated as "not ready" so the loop keeps polling.
     */
    private async serviceHasReadyEndpoints(namespace: string, name: string): Promise<boolean> {
        try {
            const res = await this.coreApi.listNamespacedEndpoints({
                namespace,
                fieldSelector: `metadata.name=${name}`,
            });
            const endpoints = res.items[0];
            const readyAddresses = endpoints?.subsets?.flatMap((s) => s.addresses ?? []);
            return readyAddresses != null && readyAddresses.length > 0;
        } catch (err) {
            logger.warn("Endpoint query failed; treating service as not ready", { namespace, service: name, err });
            return false;
        }
    }

    /**
     * Rewrites every Docker Hub image in recipe-generated workloads to pull
     * through the configured mirror (ECR pull-through cache). Mutates the
     * resources in place before they are applied. Images on other registries
     * are left untouched, so client-supplied references to e.g. ghcr.io keep
     * working.
     */
    private mirrorRecipeImages(resources: RecipeResources): void {
        const podSpecs = [
            ...resources.deployments.map((d) => d.spec?.template.spec),
            ...resources.statefulSets.map((s) => s.spec?.template.spec),
        ];
        for (const podSpec of podSpecs) {
            if (podSpec == null) continue;
            const containers = [...podSpec.containers, ...(podSpec.initContainers ?? [])];
            for (const container of containers) {
                if (container.image == null) continue;
                const mirrored = mirrorDockerHubImage(container.image, this.dockerHubMirrorUrl);
                if (mirrored !== container.image) {
                    logger.info("Mirroring service image through Docker Hub pull-through cache", {
                        from: container.image,
                        to: mirrored,
                    });
                    container.image = mirrored;
                }
            }
        }
    }

    private async applyServiceDeployment(namespace: string, deployment: k8s.V1Deployment): Promise<void> {
        const name = deployment.metadata!.name!;
        if (name == null) {
            throw new Error(
                `applyServiceDeployment received deployment.metadata.name == null on namespace ${namespace}`,
            );
        }

        try {
            await this.appsApi.createNamespacedDeployment({ namespace, body: deployment });
            logger.info(`Deployment ${name} on ${namespace} created`);
        } catch (err: unknown) {
            if (!isConflict(err)) throw err;
            await this.appsApi.replaceNamespacedDeployment({ name, namespace, body: deployment });
            logger.info(`Deployment ${name} on ${namespace} replaced`);
        }
    }

    /**
     * Applies an app Deployment by deleting any existing one first and waiting
     * until it is fully gone, then creating fresh. Recreating from a clean slate
     * (rather than replace/patch) guarantees a redeploy can't leave the workload
     * in an inconsistent state - stale pod-template fields or pods left over from
     * an incompatible spec change. Infra singletons that must stay available
     * across a redeploy (e.g. the Gatekeeper ingress proxy) use the rolling
     * `applyServiceDeployment` path instead.
     */
    private async applyDeployment(namespace: string, deployment: k8s.V1Deployment, attempts = 3): Promise<void> {
        const name = deployment.metadata?.name ?? `no-name-${randomUUID()}`;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            await this.deleteDeploymentAndWait(namespace, name);
            try {
                await this.appsApi.createNamespacedDeployment({ namespace, body: deployment });
                logger.info(`Deployment ${name} on ${namespace} created`);
                return;
            } catch (err: unknown) {
                // deleteDeploymentAndWait polls until a 404, so a conflict here means
                // the object reappeared between that read and this create (a stray
                // finalizer or a concurrent operator). Delete and retry rather than
                // failing the deploy; anything other than a conflict is a real error.
                if (!isConflict(err) || attempt === attempts) throw err;
                logger.warn(`Create raced an existing deployment ${name} on ${namespace}; retrying`, { attempt });
            }
        }
    }

    /**
     * Deletes the named Deployment (cascading, Foreground) and waits until the
     * API no longer returns it. A no-op if it doesn't exist. The wait matters
     * because deletion is asynchronous: creating a new Deployment while the old
     * object still lingers returns a 409 conflict. Foreground propagation keeps
     * the object readable until its ReplicaSets and Pods are gone, so the fresh
     * create never races leftover pods from the previous revision.
     */
    private async deleteDeploymentAndWait(namespace: string, name: string, timeoutMs = 120_000): Promise<void> {
        try {
            await this.appsApi.deleteNamespacedDeployment({ name, namespace, propagationPolicy: "Foreground" });
        } catch (err: unknown) {
            if (isNotFound(err)) return;
            throw err;
        }
        logger.info(`Deleting existing deployment ${name} on ${namespace} before recreate`);

        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                await this.appsApi.readNamespacedDeployment({ namespace, name });
            } catch (err: unknown) {
                if (isNotFound(err)) {
                    logger.info(`Existing deployment ${name} on ${namespace} deleted`);
                    return;
                }
                logger.warn("Transient error polling deployment deletion, retrying", { namespace, app: name, err });
            }
            await new Promise((r) => setTimeout(r, 1_000));
        }

        throw new Error(`Timed out waiting for existing deployment "${name}" to delete in ${namespace}`);
    }

    private async applyStatefulSet(namespace: string, statefulSet: k8s.V1StatefulSet): Promise<void> {
        const name = statefulSet.metadata!.name!;
        try {
            await this.appsApi.createNamespacedStatefulSet({
                namespace,
                body: statefulSet,
            });
        } catch (err: unknown) {
            if (isConflict(err)) {
                await this.appsApi.replaceNamespacedStatefulSet({
                    name,
                    namespace,
                    body: statefulSet,
                });
            } else {
                throw err;
            }
        }
    }

    private async applyService(namespace: string, service: k8s.V1Service): Promise<void> {
        const name = service.metadata!.name!;
        try {
            await this.coreApi.createNamespacedService({ namespace, body: service });
        } catch (err: unknown) {
            if (isConflict(err)) {
                await this.coreApi.replaceNamespacedService({
                    name,
                    namespace,
                    body: service,
                });
            } else {
                throw err;
            }
        }
    }

    private async applyNetworkPolicies(namespace: string, organizationId: string): Promise<void> {
        const policies = buildNetworkPolicies({
            namespace,
            organizationId,
            ingressControllerNamespace: this.ingressNamespace,
        });
        for (const policy of policies) {
            await this.applyNetworkPolicy(namespace, policy);
        }
        logger.info("Applied tenant isolation network policies", {
            namespace,
            organizationId,
            count: policies.length,
        });
    }

    private async applyNetworkPolicy(namespace: string, policy: k8s.V1NetworkPolicy): Promise<void> {
        const name = policy.metadata!.name!;
        try {
            await this.networkingApi.createNamespacedNetworkPolicy({ namespace, body: policy });
        } catch (err: unknown) {
            if (isConflict(err)) {
                await this.networkingApi.replaceNamespacedNetworkPolicy({
                    name,
                    namespace,
                    body: policy,
                });
            } else {
                throw err;
            }
        }
    }

    private async applyRole(namespace: string, role: k8s.V1Role): Promise<void> {
        const name = role.metadata!.name!;
        try {
            await this.rbacApi.createNamespacedRole({ namespace, body: role });
        } catch (err: unknown) {
            if (isConflict(err)) {
                await this.rbacApi.replaceNamespacedRole({ name, namespace, body: role });
            } else {
                throw err;
            }
        }
    }

    private async applyRoleBinding(namespace: string, roleBinding: k8s.V1RoleBinding): Promise<void> {
        const name = roleBinding.metadata!.name!;
        try {
            await this.rbacApi.createNamespacedRoleBinding({ namespace, body: roleBinding });
        } catch (err: unknown) {
            if (isConflict(err)) {
                await this.rbacApi.replaceNamespacedRoleBinding({ name, namespace, body: roleBinding });
            } else {
                throw err;
            }
        }
    }

    private async applyPvc(namespace: string, pvc: k8s.V1PersistentVolumeClaim): Promise<void> {
        try {
            await this.coreApi.createNamespacedPersistentVolumeClaim({
                namespace,
                body: pvc,
            });
        } catch (err: unknown) {
            if (isConflict(err)) {
                // PVCs can't be updated — that's fine, the existing one is kept
            } else {
                throw err;
            }
        }
    }

    private async applyCoreResource(namespace: string, resource: k8s.V1ConfigMap, _kind: string): Promise<void> {
        const name = resource.metadata!.name!;
        try {
            await this.coreApi.createNamespacedConfigMap({ namespace, body: resource });
        } catch (err: unknown) {
            if (isConflict(err)) {
                await this.coreApi.replaceNamespacedConfigMap({
                    name,
                    namespace,
                    body: resource,
                });
            } else {
                throw err;
            }
        }
    }
}
