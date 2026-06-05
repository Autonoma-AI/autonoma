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
    maxAttempts = 3,
): Promise<void> {
    const logger = rootLogger.child({ name: "runHookJob", namespace, app: appName });

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
            const delayMs = 15_000 * (attempt - 1);
            logger.warn("Hook Job failed, retrying", { attempt, maxAttempts, delayMs });
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
        try {
            await runHookJobOnce(kc, namespace, appName, image, command, env, logger, timeoutMs);
            return;
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            logger.error("Hook Job attempt failed", { attempt, maxAttempts, error: lastError.message });
        }
    }
    throw lastError!;
}

async function runHookJobOnce(
    kc: k8s.KubeConfig,
    namespace: string,
    appName: string,
    image: string,
    command: string,
    env: Record<string, string>,
    logger: ReturnType<typeof rootLogger.child>,
    timeoutMs: number,
): Promise<void> {
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
            labels: { "previewkit.dev/managed-by": "previewkit", "previewkit.dev/hook": "deploy" },
        },
        spec: {
            backoffLimit: 0,
            activeDeadlineSeconds: Math.ceil(timeoutMs / 1000),
            ttlSecondsAfterFinished: 300,
            template: {
                spec: {
                    restartPolicy: "Never",
                    securityContext: { runAsUser: 0 },
                    containers: [
                        {
                            name: "hook",
                            image,
                            // Some Dockerfiles strip all execute bits from node_modules
                            // (chmod 444 on all files) for security hardening. Since the
                            // job runs as root, restore +x on .bin executables before
                            // running the hook command so tools like npx/prisma work.
                            command: [
                                "/bin/sh",
                                "-c",
                                `find /app/node_modules/.bin -type f -o -type l 2>/dev/null | xargs chmod +x 2>/dev/null; ${command}`,
                            ],
                            envFrom: [{ secretRef: { name: `${appName}-secrets`, optional: true } }],
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
            logger.info("Hook Job succeeded", { jobName });
            return;
        }

        const failed = conditions.find((c) => c.type === "Failed" && c.status === "True");
        if (failed != null) {
            const logs = await captureJobLogs(coreApi, namespace, jobName);
            logger.error("Hook Job failed", { jobName, logs });
            throw new Error(`Hook Job "${jobName}" failed.\n${logs}`);
        }

        logger.info("Hook Job running", { jobName });
    }

    throw new Error(`Hook Job "${jobName}" timed out after ${timeoutMs}ms`);
}

async function captureJobLogs(coreApi: k8s.CoreV1Api, namespace: string, jobName: string): Promise<string> {
    const pod = await findJobPod(coreApi, namespace, jobName);
    if (pod == null) {
        const events = await captureJobEvents(coreApi, namespace, jobName);
        return `(no pod found)${events !== "" ? `\nk8s events: ${events}` : ""}`;
    }
    const podName = pod.metadata?.name;
    if (podName == null) return "(pod has no name)";
    const podPhase = pod.status?.phase;
    const containerState = pod.status?.containerStatuses?.[0]?.state;
    const terminated = containerState?.terminated;
    const prefix =
        terminated != null
            ? `[exit ${terminated.exitCode ?? "?"}] ${terminated.reason ?? ""} ${terminated.message ?? ""}`.trim()
            : `[phase: ${podPhase ?? "unknown"}]`;
    try {
        const logs = await coreApi.readNamespacedPodLog({ name: podName, namespace, container: "hook" });
        return `${prefix}\n${logs}`;
    } catch {
        return `${prefix} (logs unavailable)`;
    }
}

async function findJobPod(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    jobName: string,
    attempts = 4,
    delayMs = 2_000,
): Promise<k8s.V1Pod | undefined> {
    for (let i = 0; i < attempts; i++) {
        try {
            const { items } = await coreApi.listNamespacedPod({
                namespace,
                labelSelector: `job-name=${jobName}`,
            });
            if (items.length > 0) return items[0];
        } catch {
            // ignore transient list errors and retry
        }
        if (i < attempts - 1) await new Promise<void>((r) => setTimeout(r, delayMs));
    }
    return undefined;
}

async function captureJobEvents(coreApi: k8s.CoreV1Api, namespace: string, jobName: string): Promise<string> {
    try {
        const { items } = await coreApi.listNamespacedEvent({
            namespace,
            fieldSelector: `involvedObject.name=${jobName}`,
        });
        return items.map((e) => `${e.reason ?? "?"}: ${e.message ?? ""}`).join(" | ");
    } catch {
        return "";
    }
}
