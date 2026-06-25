import { KubeConfig } from "@kubernetes/client-node";
import { ObjectCoreV1Api as CoreV1Api } from "@kubernetes/client-node/dist/gen/types/ObjectParamAPI";
import { env } from "./env";

export interface K8sJobOptions {
    name: string;
    namespace: string;
    image: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
}

export interface K8sClient {
    createJob(options: K8sJobOptions): Promise<void>;
    deleteJob(name: string, namespace: string): Promise<void>;
    getJobStatus(name: string, namespace: string): Promise<string>;
}

export type ImageKey = "ios" | "android" | "web" | "workflow-device-locking" | "reviewer" | "eval-job-finalizer";

export function makeKubeConfig(): KubeConfig {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    return kc;
}

export async function getImage(architecture: ImageKey): Promise<string> {
    const kc = makeKubeConfig();
    const api = kc.makeApiClient(CoreV1Api);
    const config = await api.readNamespacedConfigMap({ name: "image-version", namespace: env.NAMESPACE });
    if (!config.data) {
        throw new Error("ConfigMap data is undefined");
    }
    const image = config.data[architecture];
    if (!image) {
        throw new Error(`No image configuration found for namespace ${env.NAMESPACE}`);
    }
    return image;
}
