import * as k8s from "@kubernetes/client-node";
import { logger as rootLogger } from "../logger";

const POLL_INTERVAL_MS = 3_000;

/**
 * Creates a one-off K8s Job in `namespace` using `image`, runs `command`
 * inside it, waits for completion, and throws on failure (with captured logs).
 *
 * Used by pre_deploy hooks (type: job) to run migrations — e.g. prisma db
 * push — before app Deployments start, so services never boot against a
 * missing schema.
 */
export async function runHookJob(
    kc: k8s.KubeConfig,
    namespace: string,
    appName: string,
    image: string,
    command: string,
    env: Record<string, string>,
    timeoutMs = 300_000,
): Promise<void> {
    const logger = rootLogger.child({ name: "runHookJob", namespace, app: appName });

    const suffix = Math.random().toString(36).slice(2, 8);
    const jobName = `${appName.slice(0, 48)}-hook-${suffix}`;

    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const envVars = Object.entries(env).map(([name, value]) => ({ name, value }));
    const job: k8s.V1Job = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
            name: jobName,
            namespace,
            labels: { "previewkit.dev/managed-by": "previewkit", "previewkit.dev/hook": "pre-deploy" },
        },
        spec: {
            backoffLimit: 0,
            activeDeadlineSeconds: Math.ceil(timeoutMs / 1000),
            ttlSecondsAfterFinished: 300,
            template: {
                spec: {
                    restartPolicy: "Never",
                    containers: [
                        {
                            name: "hook",
                            image,
                            command: ["/bin/sh", "-c", command],
                            env: envVars,
                            resources: {
                                requests: { cpu: "100m", memory: "512Mi" },
                                limits: { memory: "1Gi" },
                            },
                        },
                    ],
                },
            },
        },
    };

    logger.info("Creating pre-deploy hook Job", { jobName, image, command });
    await batchApi.createNamespacedJob({ namespace, body: job });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        const { status } = await batchApi.readNamespacedJob({ name: jobName, namespace });
        const conditions = status?.conditions ?? [];

        const succeeded = conditions.find((c) => c.type === "Complete" && c.status === "True");
        if (succeeded != null) {
            logger.info("Pre-deploy hook Job succeeded", { jobName });
            return;
        }

        const failed = conditions.find((c) => c.type === "Failed" && c.status === "True");
        if (failed != null) {
            const logs = await captureJobLogs(coreApi, namespace, jobName);
            logger.error("Pre-deploy hook Job failed", { jobName, logs });
            throw new Error(`Pre-deploy hook Job "${jobName}" failed.\n${logs}`);
        }

        logger.info("Pre-deploy hook Job running", { jobName });
    }

    throw new Error(`Pre-deploy hook Job "${jobName}" timed out after ${timeoutMs}ms`);
}

async function captureJobLogs(coreApi: k8s.CoreV1Api, namespace: string, jobName: string): Promise<string> {
    try {
        const pods = await coreApi.listNamespacedPod({
            namespace,
            labelSelector: `job-name=${jobName}`,
        });
        const pod = pods.items[0];
        if (pod == null) return "(no pod found)";
        const podName = pod.metadata?.name;
        if (podName == null) return "(pod has no name)";
        return await coreApi.readNamespacedPodLog({ name: podName, namespace, container: "hook" });
    } catch {
        return "(failed to retrieve logs)";
    }
}
