import * as k8s from "@kubernetes/client-node";
import type { AppConfig, PreviewConfig } from "../config/schema";
import { logger } from "../logger";
import { computeDeployWaves } from "../pipeline/deploy-graph";
import { RecipeRegistry } from "../recipes/recipe-registry";
import type { AwsExternalSecretManager } from "../secrets/aws-external-secret-manager";
import { EnvInjector } from "./env-injector";
import { isConflict } from "./k8s-errors";
import { NamespaceManager, type NamespaceAnnotations } from "./namespace-manager";
import { buildNetworkPolicies } from "./network-policy-factory";
import {
    buildAppDeployment,
    buildAppHostname,
    buildAppHttpRoute,
    buildAppService,
    buildAppTargetGroupConfig,
    HTTP_ROUTE_GROUP,
    HTTP_ROUTE_PLURAL,
    HTTP_ROUTE_VERSION,
    TARGET_GROUP_CONFIG_GROUP,
    TARGET_GROUP_CONFIG_PLURAL,
    TARGET_GROUP_CONFIG_VERSION,
    type GatewayRef,
    type HttpRoute,
    type TargetGroupConfiguration,
} from "./resource-factory";

/**
 * Per-app outcome of the deploy phase. Apps are deployed independently — one
 * app's failure does not abort the others.
 *
 * - `ok`: Deployment, Service, HTTPRoute applied and the Deployment reported
 *   ready. `url` is set.
 * - `failed`: K8s apply or readiness wait threw. `url` is still set because
 *   the DNS host is computed from the app name and may resolve to a partially
 *   applied resource (commonly serving 502).
 * - `skipped`: deployer was not given an imageTag for this app (its build
 *   failed upstream), so no K8s resources were applied at all.
 */
export type AppDeployOutcome =
    | { status: "ok"; url: string }
    | { status: "failed"; url: string; error: string }
    | { status: "skipped"; reason: string };

export interface DeployResult {
    namespace: string;
    urls: Record<string, string>;
    appOutcomes: Record<string, AppDeployOutcome>;
}

interface AppDeployContext {
    namespace: string;
    prNumber: number;
    owner: string;
    repoSlug: string;
    domain: string;
    config: PreviewConfig;
    imageTags: Record<string, string>;
    awsSecretsByApp: Map<string, string>;
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
    commentId?: string;
}

export class Deployer {
    private coreApi: k8s.CoreV1Api;
    private appsApi: k8s.AppsV1Api;
    private networkingApi: k8s.NetworkingV1Api;
    private customApi: k8s.CustomObjectsApi;
    private namespaceManager: NamespaceManager;
    private envInjector: EnvInjector;
    private recipeRegistry: RecipeRegistry;

    constructor(
        private kc: k8s.KubeConfig,
        private domain: string,
        private gateway: GatewayRef,
        private gatewaySubnetCidrs: string[] = [],
        private awsExternalSecretManager?: AwsExternalSecretManager,
    ) {
        this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
        this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
        this.networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
        this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
        this.namespaceManager = new NamespaceManager(kc);
        this.recipeRegistry = new RecipeRegistry();
        this.envInjector = new EnvInjector(this.recipeRegistry);
    }

    async deploy(opts: DeployOptions): Promise<DeployResult> {
        const waves = computeDeployWaves(opts.config.apps);
        return this.deployOrdered(opts, waves);
    }

    private async deployOrdered(opts: DeployOptions, waves: AppConfig[][]): Promise<DeployResult> {
        const { repoFullName, prNumber, headSha, organizationId, config, imageTags, commentId } = opts;
        const domain = config.domain ?? this.domain;

        // 1. Create namespace
        const namespace = await this.namespaceManager.create(repoFullName, prNumber, organizationId, {
            commentId,
            lastDeployedSha: headSha,
        });

        logger.info("Deploying preview environment", { namespace, prNumber, organizationId });

        // 2. Apply NetworkPolicies for tenant isolation before any workload runs
        await this.applyNetworkPolicies(namespace, organizationId);

        // 3. Apply ExternalSecrets for any AWS Secrets Manager registrations for this org
        const appNames = config.apps.map((a) => a.name);
        const awsSecretsByApp =
            this.awsExternalSecretManager != null
                ? await this.awsExternalSecretManager.applyForNamespace(organizationId, namespace, appNames)
                : new Map<string, string>();

        // 4. Deploy service recipes (postgres, redis, etc.)
        for (const svcConfig of config.services) {
            const recipe = this.recipeRegistry.get(svcConfig.recipe);
            const resources = recipe.generate(svcConfig, namespace);

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
                await this.applyDeployment(namespace, dep);
            }
            for (const svc of resources.services) {
                await this.applyService(namespace, svc);
            }

            logger.info("Deployed service recipe", { service: svcConfig.name, recipe: svcConfig.recipe, namespace });
        }

        // 5. Wait for service readiness
        await this.waitForServicesReady(namespace, config);

        // 6. Deploy apps wave by wave; apps within each wave are deployed in parallel.
        //    Each app is its own failure domain — one app's failure (build skip
        //    or K8s apply error) does not stop other apps from deploying. Wave
        //    ordering is preserved purely as a hint: depends_on still controls
        //    *when* an app is attempted, but a downstream app is attempted even
        //    if its upstream failed (the user prefers a partial preview over
        //    none — see the per-app independence design discussion).
        const owner = repoFullName.split("/")[0]!;
        const repoSlug = this.buildRepoSlug(repoFullName);
        const urls: Record<string, string> = {};
        const appOutcomes: Record<string, AppDeployOutcome> = {};

        const appCtx: AppDeployContext = {
            namespace,
            prNumber,
            owner,
            repoSlug,
            domain,
            config,
            imageTags,
            awsSecretsByApp,
        };

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
                    const url = `https://${buildAppHostname(app.name, prNumber, repoSlug, domain)}`;
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

        return { namespace, urls, appOutcomes };
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
            const url = `https://${buildAppHostname(app.name, ctx.prNumber, ctx.repoSlug, ctx.domain)}`;
            return { status: "failed", url, error: message };
        }
    }

    public buildRepoSlug(repoFullName: string): string {
        // `owner/repo` -> `owner-repo`, sanitized + truncated so the full
        // hostname stays under the 63-char DNS label limit even with long
        // app names and PR numbers.
        return repoFullName
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .slice(0, 20)
            .replace(/^-+|-+$/g, "");
    }

    async teardown(repoFullName: string, prNumber: number): Promise<void> {
        const namespace = this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
        await this.namespaceManager.delete(namespace);
    }

    getNamespaceName(repoFullName: string, prNumber: number): string {
        return this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
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

    /** Exposed so the pipeline can template `build_args` (which run BEFORE
     *  any deployer call) using the same `{{name.host/port/url}}` grammar
     *  the deployer applies to runtime env. */
    getEnvInjector(): EnvInjector {
        return this.envInjector;
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
        const { namespace, prNumber, owner, repoSlug, domain, config, imageTags, awsSecretsByApp } = opts;

        const imageTag = imageTags[app.name];
        if (imageTag == null) {
            throw new Error(`No image tag found for app "${app.name}"`);
        }

        const templateContext = { pr: String(prNumber), namespace, owner };
        const publicUrlInfo = { domain, repoSlug, prNumber };
        const resolvedEnv = this.envInjector.resolve(
            app.env,
            config.apps,
            config.services,
            namespace,
            templateContext,
            publicUrlInfo,
        );

        const deployment = buildAppDeployment({
            app,
            namespace,
            imageTag,
            resolvedEnv,
            prNumber,
            awsSecretName: awsSecretsByApp.get(app.name),
        });
        const service = buildAppService({ app, namespace, imageTag, resolvedEnv, prNumber });
        const routeOpts = { app, namespace, prNumber, repoSlug, domain, gateway: this.gateway };
        const targetGroupConfig = buildAppTargetGroupConfig(routeOpts);
        const httpRoute = buildAppHttpRoute(routeOpts);

        await this.applyDeployment(namespace, deployment);
        await this.applyService(namespace, service);
        // TargetGroupConfig must exist before the HTTPRoute so the ALB
        // controller picks up IP-target config on first reconcile.
        await this.applyTargetGroupConfig(namespace, targetGroupConfig);
        await this.applyHttpRoute(namespace, httpRoute);

        await this.waitForDeploymentReady(namespace, app.name);

        const host = buildAppHostname(app.name, prNumber, repoSlug, domain);
        const url = `https://${host}`;
        logger.info("Deployed app", { app: app.name, url, namespace });
        return { name: app.name, url };
    }

    private async waitForDeploymentReady(namespace: string, appName: string, timeoutMs = 180_000): Promise<void> {
        const start = Date.now();
        logger.info("Waiting for deployment to be ready", { namespace, app: appName });

        while (Date.now() - start < timeoutMs) {
            try {
                const res = await this.appsApi.readNamespacedDeployment({ namespace, name: appName });
                const { metadata, spec, status } = res;
                const desired = spec?.replicas ?? 1;
                const generation = metadata?.generation ?? 0;
                const observed = status?.observedGeneration ?? 0;
                const updated = status?.updatedReplicas ?? 0;
                const available = status?.availableReplicas ?? 0;

                if (observed >= generation && updated >= desired && available >= desired) {
                    logger.info("Deployment ready", { namespace, app: appName });
                    return;
                }
            } catch (err) {
                logger.warn("Transient error polling deployment status, retrying", { namespace, app: appName, err });
            }
            await new Promise((r) => setTimeout(r, 3000));
        }

        throw new Error(`Timed out waiting for deployment "${appName}" to be ready in ${namespace}`);
    }

    private async waitForServicesReady(namespace: string, config: PreviewConfig, timeoutMs = 120_000): Promise<void> {
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

        while (Date.now() - start < timeoutMs) {
            let allReady = true;

            for (const name of serviceNames) {
                try {
                    const res = await this.coreApi.listNamespacedEndpoints({
                        namespace,
                        fieldSelector: `metadata.name=${name}`,
                    });
                    const endpoints = res.items[0];
                    const readyAddresses = endpoints?.subsets?.flatMap((s) => s.addresses ?? []);
                    if (!readyAddresses?.length) {
                        allReady = false;
                        break;
                    }
                } catch {
                    allReady = false;
                    break;
                }
            }

            if (allReady) {
                logger.info("All services ready", { namespace });
                return;
            }

            await new Promise((r) => setTimeout(r, 3000));
        }

        throw new Error(`Timed out waiting for services to be ready in ${namespace}`);
    }

    private async applyDeployment(namespace: string, deployment: k8s.V1Deployment): Promise<void> {
        const name = deployment.metadata!.name!;
        try {
            await this.appsApi.createNamespacedDeployment({ namespace, body: deployment });
        } catch (err: unknown) {
            if (isConflict(err)) {
                await this.appsApi.replaceNamespacedDeployment({
                    name,
                    namespace,
                    body: deployment,
                });
            } else {
                throw err;
            }
        }
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
            ingressControllerNamespace: this.gateway.namespace,
            gatewaySubnetCidrs: this.gatewaySubnetCidrs,
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

    private async applyHttpRoute(namespace: string, route: HttpRoute): Promise<void> {
        await this.applyCustomObject(namespace, HTTP_ROUTE_GROUP, HTTP_ROUTE_VERSION, HTTP_ROUTE_PLURAL, route);
    }

    private async applyTargetGroupConfig(namespace: string, config: TargetGroupConfiguration): Promise<void> {
        await this.applyCustomObject(
            namespace,
            TARGET_GROUP_CONFIG_GROUP,
            TARGET_GROUP_CONFIG_VERSION,
            TARGET_GROUP_CONFIG_PLURAL,
            config,
        );
    }

    private async applyCustomObject(
        namespace: string,
        group: string,
        version: string,
        plural: string,
        body: HttpRoute | TargetGroupConfiguration,
    ): Promise<void> {
        const name = body.metadata.name;
        try {
            await this.customApi.createNamespacedCustomObject({
                group,
                version,
                namespace,
                plural,
                body,
            });
        } catch (err: unknown) {
            if (!isConflict(err)) {
                throw err;
            }
            // CustomObjectsApi rejects replace without a fresh resourceVersion,
            // so read the existing object first and merge it in.
            const existing = (await this.customApi.getNamespacedCustomObject({
                group,
                version,
                namespace,
                plural,
                name,
            })) as { metadata?: { resourceVersion?: string } };
            const merged = {
                ...body,
                metadata: {
                    ...body.metadata,
                    resourceVersion: existing.metadata?.resourceVersion,
                },
            };
            await this.customApi.replaceNamespacedCustomObject({
                group,
                version,
                namespace,
                plural,
                name,
                body: merged,
            });
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
