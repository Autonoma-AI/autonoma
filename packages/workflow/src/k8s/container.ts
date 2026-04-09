import type { V1Container, V1EnvVar } from "@kubernetes/client-node";
import { env } from "../env";
import type { ImageKey, SecretFileName } from "./image-keys";
import { getK8sClient } from "./k8s-client";

export interface BuildDockerfileContainerParams extends Omit<V1Container, "imagePullPolicy" | "envFrom" | "image"> {
    /** The key to look up the container image from the K8s ConfigMap. */
    imageKey: ImageKey;

    /** The secret file name */
    secretFile: SecretFileName;
}

/** Envs shared by dockerfile containers */
const SHARED_ENVS: V1EnvVar[] = [
    { name: "NAMESPACE", value: env.NAMESPACE },
    { name: "SENTRY_ENV", value: env.SENTRY_ENV },
    { name: "DATABASE_URL", value: env.DATABASE_URL },
];

/**
 * Build container options for a docker image-based container.
 *
 * Resolves the image from a K8s ConfigMap, mounts the secret file,
 * and includes shared environment variables.
 */
export async function imageContainer({
    name,
    env: containerEnv,
    imageKey,
    secretFile,
    ...rest
}: BuildDockerfileContainerParams): Promise<V1Container> {
    const k8s = getK8sClient();

    return {
        name,
        image: await k8s.getImage(imageKey),
        imagePullPolicy: "IfNotPresent",
        envFrom: [{ secretRef: { name: secretFile } }],
        env: [...SHARED_ENVS, ...(containerEnv ?? [])],
        ...rest,
    };
}
