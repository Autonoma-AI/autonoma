import { type Logger, logger } from "@autonoma/logger";
import { Workflow } from "@kubernetes-models/argo-workflows/argoproj.io/v1alpha1";
import { CoreV1Api, CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";
import { env } from "../env";
import type { ArgoDagData } from "./argo/dag-builder";
import { type ImageKey, imageVersionConfigSchema } from "./image-keys";

export class K8sClientError extends Error {}

export class ConfigMapNotFoundError extends K8sClientError {
    constructor(name: string, namespace: string) {
        super(`ConfigMap ${name} not found in namespace ${namespace}`);
        this.name = "ConfigMapNotFoundError";
    }
}

export class MissingImageKeyError extends K8sClientError {
    constructor(imageKey: ImageKey, namespace: string) {
        super(`Image key ${imageKey} not found in image version config in namespace ${namespace}`);
        this.name = "MissingImageKeyError";
    }
}

export interface CreateWorkflowParams {
    name: string;
    labels: Record<string, string>;
    dagData: ArgoDagData;
}

export interface ArgoWorkflowRef {
    name: string;
    uid: string;
}

interface ArgoWorkflowListItem {
    metadata?: {
        name?: string;
        uid?: string;
        creationTimestamp?: string;
    };
}

interface ArgoWorkflowListResponse {
    items?: ArgoWorkflowListItem[];
}

export class K8sClient {
    private readonly logger: Logger;

    private readonly coreApi: CoreV1Api;
    private readonly customObjectsApi: CustomObjectsApi;

    constructor(
        private readonly kc: KubeConfig,
        private readonly namespace: string,
    ) {
        this.logger = logger.child({ name: this.constructor.name, namespace });
        this.coreApi = kc.makeApiClient(CoreV1Api);
        this.customObjectsApi = kc.makeApiClient(CustomObjectsApi);
    }

    static fromEnv() {
        const kc = new KubeConfig();
        kc.loadFromDefault();
        return new K8sClient(kc, env.NAMESPACE);
    }

    private async readImageVersionConfig() {
        this.logger.info(`Reading image ConfigMap from namespace: ${this.namespace}`);

        const config = await this.coreApi.readNamespacedConfigMap({ name: "image-version", namespace: this.namespace });
        if (config.data == null) {
            this.logger.fatal("Image version config map not found");
            throw new ConfigMapNotFoundError("image-version", this.namespace);
        }

        this.logger.info("Successfully read image ConfigMap before parsing", { config });

        const imageVersionConfig = imageVersionConfigSchema.safeParse(config.data);
        if (!imageVersionConfig.success) {
            this.logger.fatal("Invalid image version config", imageVersionConfig.error);
            throw new K8sClientError("Invalid image version config");
        }

        this.logger.info("Successfully read image ConfigMap");

        return imageVersionConfig.data;
    }

    public async getImage(imageKey: ImageKey): Promise<string> {
        this.logger.info("Resolving image", { imageKey });

        const config = await this.readImageVersionConfig();
        const image = config[imageKey];
        if (image == null) {
            this.logger.fatal(`Image key ${imageKey} not found in image version config`);
            throw new MissingImageKeyError(imageKey, this.namespace);
        }

        this.logger.info("Resolved image", { imageKey, image });

        return image;
    }

    private workflowGroupParams() {
        return {
            group: "argoproj.io",
            version: "v1alpha1",
            namespace: "argo",
            plural: "workflows",
        };
    }

    public async createWorkflow({ name, labels, dagData }: CreateWorkflowParams): Promise<void> {
        this.logger.info("Creating Argo workflow", { name, labels });

        const workflow = new Workflow({
            metadata: {
                generateName: `${name}-`,
                namespace: "argo",
                labels,
            },
            spec: {
                entrypoint: dagData.entrypoint,
                serviceAccountName: "argo",
                ttlStrategy: { secondsAfterCompletion: 60 * 60 },
                templates: dagData.templateDefinitions,
            },
        });

        try {
            await this.customObjectsApi.createNamespacedCustomObject({ ...this.workflowGroupParams(), body: workflow });
        } catch (error) {
            this.logger.fatal("Failed to create Argo workflow", error, {
                name,
                labels,
                entrypoint: dagData.entrypoint,
                templateCount: dagData.templateDefinitions.length,
            });
            throw error;
        }

        this.logger.info("Argo workflow created successfully", { name });
    }

    public async queryWorkflows(labelSelector: string) {
        this.logger.info("Running workflow query", { labelSelector });

        const response = (await this.customObjectsApi.listNamespacedCustomObject({
            ...this.workflowGroupParams(),
            labelSelector,
        })) as ArgoWorkflowListResponse;

        this.logger.info("Workflow query completed", { count: response.items?.length ?? 0 });

        return response.items ?? [];
    }

    public async deleteWorkflow(name: string): Promise<void> {
        this.logger.info("Deleting Argo workflow", { name });

        try {
            await this.customObjectsApi.deleteNamespacedCustomObject({
                ...this.workflowGroupParams(),
                name,
            });
            this.logger.info("Argo workflow deleted", { name });
        } catch (error) {
            this.logger.error("Failed to delete Argo workflow", error, { name });
            throw error;
        }
    }
}

let k8sClient: K8sClient | undefined;

/** Get the singleton K8sClient instance. */
export function getK8sClient(): K8sClient {
    if (k8sClient == null) k8sClient = K8sClient.fromEnv();

    return k8sClient;
}
