import * as k8s from "@kubernetes/client-node";
import { logger as rootLogger } from "../logger";

const POLL_INTERVAL_MS = 3_000;

/**
 * Creates a one-off K8s Job in `namespace` using `image`, runs `command`
 * inside it, waits for completion, and throws on failure (with captured logs).
 *
 * Every pre- and post-deploy hook runs this way. A pre_deploy hook typically
 * runs migrations (e.g. prisma db push) before app Deployments start, so
 * services never boot against a missing schema. The Job does not retry: a
 * failure fails the Job immediately rather than re-running the command.
 */
export interface RunHookJobOptions {
    timeoutMs?: number;
    /**
     * Called for each line of the Job pod's output once it finishes (whether it
     * succeeded or failed). Job pods merge stdout and stderr into a single log,
     * so lines are relayed after completion rather than streamed live.
     */
    onLog?: (line: string) => void;
}

export async function runHookJob(
    kc: k8s.KubeConfig,
    namespace: string,
    appName: string,
    image: string,
    command: string,
    env: Record<string, string>,
    options?: RunHookJobOptions,
): Promise<void> {
    const logger = rootLogger.child({ name: "runHookJob", namespace, app: appName });
    const timeoutMs = options?.timeoutMs ?? 300_000;
    const onLog = options?.onLog;

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
            // No retries: a failed hook fails the Job immediately (backoffLimit
            // 0 + restartPolicy Never below), so a broken command is never
            // silently re-run.
            backoffLimit: 0,
            activeDeadlineSeconds: Math.ceil(timeoutMs / 1000),
            // Keep the finished Job (and its pod) around for 30 minutes so its
            // logs stay inspectable via kubectl after the deploy completes.
            ttlSecondsAfterFinished: 1800,
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

    logger.info("Creating hook Job", { jobName, image, command });
    await batchApi.createNamespacedJob({ namespace, body: job });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        const { status } = await batchApi.readNamespacedJob({ name: jobName, namespace });
        const conditions = status?.conditions ?? [];

        const succeeded = conditions.find((c) => c.type === "Complete" && c.status === "True");
        if (succeeded != null) {
            logger.info("Hook Job succeeded", { jobName });
            if (onLog != null) await relayJobLogs(coreApi, namespace, jobName, onLog, logger);
            return;
        }

        const failed = conditions.find((c) => c.type === "Failed" && c.status === "True");
        if (failed != null) {
            const logs = await captureJobLogs(coreApi, namespace, jobName);
            if (onLog != null) relayLines(logs, onLog);
            logger.error("Hook Job failed", { jobName });
            throw new Error(`Hook Job "${jobName}" failed.\n${logs}`);
        }

        logger.info("Hook Job running", { jobName });
    }

    throw new Error(`Hook Job "${jobName}" timed out after ${timeoutMs}ms`);
}

/**
 * Reads the finished Job pod's logs and relays them line-by-line to `onLog` so
 * a successful hook's output still reaches the build-log viewer. Best-effort:
 * a failure to read logs is logged and swallowed, never propagated.
 */
async function relayJobLogs(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    jobName: string,
    onLog: (line: string) => void,
    logger: ReturnType<typeof rootLogger.child>,
): Promise<void> {
    const pod = await findJobPod(coreApi, namespace, jobName);
    const podName = pod?.metadata?.name;
    if (podName == null) {
        logger.warn("Hook Job pod not found, cannot relay logs", { jobName });
        return;
    }
    try {
        const logs = await coreApi.readNamespacedPodLog({ name: podName, namespace, container: "hook" });
        relayLines(logs, onLog);
    } catch (err) {
        logger.warn("Failed to read hook Job pod logs for relay", { jobName, podName, err });
    }
}

/** Emit each line of `text` to `onLog`, dropping a single trailing newline. */
function relayLines(text: string, onLog: (line: string) => void): void {
    if (text === "") return;
    const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
    for (const line of trimmed.split("\n")) onLog(line);
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
