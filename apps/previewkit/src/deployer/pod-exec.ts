import { PassThrough } from "node:stream";
import * as k8s from "@kubernetes/client-node";
import { logger as rootLogger } from "../logger";

export interface ExecResult {
    stdout: string;
    stderr: string;
}

/**
 * Run a shell command in the first running pod of a Deployment in `namespace`,
 * using the K8s API server's exec subresource (no `kubectl` binary required).
 */
export async function execInDeploymentPod(
    kc: k8s.KubeConfig,
    namespace: string,
    appLabel: string,
    command: string,
): Promise<ExecResult> {
    const logger = rootLogger.child({ name: "execInDeploymentPod", namespace, appLabel });

    const pod = await findRunningPod(kc, namespace, appLabel);
    if (pod == null) {
        throw new Error(`No running pod found in ${namespace} for app=${appLabel}`);
    }

    const podName = pod.metadata!.name!;
    const containerName = pod.spec!.containers[0]!.name;

    logger.info("Executing command in pod", { podName, containerName, command });

    const exec = new k8s.Exec(kc);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    await new Promise<void>((resolve, reject) => {
        exec.exec(
            namespace,
            podName,
            containerName,
            ["/bin/sh", "-c", command],
            stdout,
            stderr,
            null,
            false,
            (status) => {
                if (status.status === "Success") {
                    resolve();
                    return;
                }
                const exitCode = status.details?.causes?.find((c) => c.reason === "ExitCode")?.message;
                reject(
                    new Error(
                        `Command failed in ${podName}: ${status.message ?? "non-zero exit"}${
                            exitCode != null ? ` (exit ${exitCode})` : ""
                        }`,
                    ),
                );
            },
        ).then((ws) => {
            ws.on("close", () => {
                stdout.end();
                stderr.end();
            });
            ws.on("error", reject);
        }, reject);
    });

    return {
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
    };
}

async function findRunningPod(
    kc: k8s.KubeConfig,
    namespace: string,
    appLabel: string,
    timeoutMs = 120_000,
    pollIntervalMs = 3_000,
): Promise<k8s.V1Pod | undefined> {
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const res = await coreApi.listNamespacedPod({
            namespace,
            labelSelector: `app=${appLabel}`,
        });
        const running = res.items.find(
            (pod) => pod.status?.phase === "Running" && pod.metadata?.deletionTimestamp == null,
        );
        if (running != null) return running;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return undefined;
}
