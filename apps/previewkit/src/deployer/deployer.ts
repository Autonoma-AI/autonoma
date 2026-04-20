import * as k8s from "@kubernetes/client-node";
import type { PreviewConfig } from "../config/schema";
import { logger } from "../logger";
import { RecipeRegistry } from "../recipes/recipe-registry";
import { EnvInjector } from "./env-injector";
import { isConflict } from "./k8s-errors";
import { NamespaceManager, type NamespaceAnnotations } from "./namespace-manager";
import { buildAppDeployment, buildAppService, buildNginxResources } from "./resource-factory";

export interface DeployResult {
    namespace: string;
    urls: Record<string, string>;
}

export interface DeployOptions {
    repoFullName: string;
    prNumber: number;
    headSha: string;
    config: PreviewConfig;
    imageTags: Record<string, string>;
    storedSecrets: Record<string, Record<string, string>>;
    commentId?: string;
}

export class Deployer {
    private coreApi: k8s.CoreV1Api;
    private appsApi: k8s.AppsV1Api;
    private networkingApi: k8s.NetworkingV1Api;
    private namespaceManager: NamespaceManager;
    private envInjector: EnvInjector;
    private recipeRegistry: RecipeRegistry;

    constructor(
        private kc: k8s.KubeConfig,
        private domain: string,
    ) {
        this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
        this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
        this.networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
        this.namespaceManager = new NamespaceManager(kc);
        this.recipeRegistry = new RecipeRegistry();
        this.envInjector = new EnvInjector(this.recipeRegistry);
    }

    async deploy(opts: DeployOptions): Promise<DeployResult> {
        const { repoFullName, prNumber, headSha, config, imageTags, storedSecrets, commentId } = opts;
        const domain = config.domain ?? this.domain;

        // 1. Create namespace
        const namespace = await this.namespaceManager.create(repoFullName, prNumber, {
            commentId,
            lastDeployedSha: headSha,
        });

        logger.info("Deploying preview environment", { namespace, prNumber });

        // 2. Deploy service recipes (postgres, redis, etc.)
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

        // 3. Wait for service readiness
        await this.waitForServicesReady(namespace, config);

        // 4. Deploy apps
        const owner = repoFullName.split("/")[0]!;
        const urls: Record<string, string> = {};

        for (const app of config.apps) {
            const imageTag = imageTags[app.name];
            if (!imageTag) {
                throw new Error(`No image tag found for app "${app.name}"`);
            }

            const appSecrets = storedSecrets[app.name] ?? {};
            const context = { pr: String(prNumber), namespace, owner };
            const resolvedEnv = this.envInjector.resolve(
                app.env,
                appSecrets,
                config.apps,
                config.services,
                namespace,
                context,
            );

            const deployment = buildAppDeployment({ app, namespace, imageTag, resolvedEnv, prNumber });
            const service = buildAppService({ app, namespace, imageTag, resolvedEnv, prNumber });

            await this.applyDeployment(namespace, deployment);
            await this.applyService(namespace, service);

            const url = `https://${app.name}.pr-${prNumber}.${owner}.${domain}`;
            urls[app.name] = url;

            logger.info("Deployed app", { app: app.name, url, namespace });
        }

        // 5. Deploy Nginx router for subdomain-based routing
        const nginx = buildNginxResources({ apps: config.apps, namespace, owner, prNumber, domain });
        await this.applyCoreResource(namespace, nginx.configMap, "configmaps");
        await this.applyDeployment(namespace, nginx.deployment);
        await this.applyService(namespace, nginx.service);
        await this.applyIngress(namespace, nginx.ingress);

        logger.info("Deployed Nginx router", { namespace, host: `*.pr-${prNumber}.${owner}.${domain}` });

        return { namespace, urls };
    }

    async teardown(repoFullName: string, prNumber: number): Promise<void> {
        const namespace = this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
        await this.namespaceManager.delete(namespace);
    }

    async getNamespaceAnnotations(repoFullName: string, prNumber: number) {
        const namespace = this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
        return this.namespaceManager.getAnnotations(namespace);
    }

    async ensureNamespace(repoFullName: string, prNumber: number, annotations?: NamespaceAnnotations): Promise<string> {
        return this.namespaceManager.create(repoFullName, prNumber, annotations);
    }

    async updateStatus(repoFullName: string, prNumber: number, annotations: NamespaceAnnotations): Promise<void> {
        const namespace = this.namespaceManager.buildNamespaceName(repoFullName, prNumber);
        await this.namespaceManager.updateAnnotations(namespace, annotations);
    }

    private async waitForServicesReady(namespace: string, config: PreviewConfig, timeoutMs = 120_000): Promise<void> {
        if (config.services.length === 0) return;

        const start = Date.now();
        const serviceNames = config.services.map((s) => s.name);

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

    private async applyIngress(namespace: string, ingress: k8s.V1Ingress): Promise<void> {
        const name = ingress.metadata!.name!;
        try {
            await this.networkingApi.createNamespacedIngress({
                namespace,
                body: ingress,
            });
        } catch (err: unknown) {
            if (isConflict(err)) {
                await this.networkingApi.replaceNamespacedIngress({
                    name,
                    namespace,
                    body: ingress,
                });
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
