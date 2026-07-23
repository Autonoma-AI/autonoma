import { PassThrough } from "node:stream";
import { sleep } from "@autonoma/utils/sleep";
import * as k8s from "@kubernetes/client-node";
import { logger as rootLogger } from "../logger";
import { makeLineRelay } from "./line-relay";

export interface ExecResult {
    stdout: string;
    stderr: string;
}

export interface ExecOptions {
    /** Data to pipe to the command's stdin. */
    stdin?: Buffer;
    /**
     * Called for each complete line of output as it arrives, before the command
     * exits. Lines carry their originating stream and have no trailing newline.
     * The full output is still buffered and returned in {@link ExecResult}.
     */
    onLine?: (stream: "stdout" | "stderr", line: string) => void;
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
    options?: ExecOptions,
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
    const stdoutRelay = makeLineRelay("stdout", options?.onLine);
    const stderrRelay = makeLineRelay("stderr", options?.onLine);
    stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        stdoutRelay.push(chunk);
    });
    stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        stderrRelay.push(chunk);
    });

    let stdinStream: PassThrough | null = null;
    if (options?.stdin != null) {
        stdinStream = new PassThrough();
        stdinStream.end(options.stdin);
    }

    // The status callback fires when the command exits, but stdout/stderr bytes
    // may still be in transit over the WebSocket. Store the failure and only
    // resolve/reject after ws.close so the buffers are fully drained.
    await new Promise<void>((resolve, reject) => {
        let failedStatus: k8s.V1Status | undefined;

        exec.exec(
            namespace,
            podName,
            containerName,
            ["/bin/sh", "-c", command],
            stdout,
            stderr,
            stdinStream,
            false,
            (status) => {
                if (status.status !== "Success") {
                    failedStatus = status;
                }
            },
        ).then((ws) => {
            ws.on("close", () => {
                stdout.end();
                stderr.end();
                stdoutRelay.flush();
                stderrRelay.flush();
                if (failedStatus != null) {
                    const exitCode = failedStatus.details?.causes?.find((c) => c.reason === "ExitCode")?.message;
                    const out = Buffer.concat(stdoutChunks).toString("utf-8").trim();
                    const err = Buffer.concat(stderrChunks).toString("utf-8").trim();
                    const captured = [out, err].filter(Boolean).join("\n");
                    reject(
                        new Error(
                            `Command failed in ${podName}: ${failedStatus.message ?? "non-zero exit"}` +
                                `${exitCode != null ? ` (exit ${exitCode})` : ""}` +
                                `${captured ? `\n${captured}` : ""}`,
                        ),
                    );
                } else {
                    resolve();
                }
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
        const running = res.items.find((pod) => {
            if (pod.status?.phase !== "Running") return false;
            if (pod.metadata?.deletionTimestamp != null) return false;
            const containerStatuses = pod.status?.containerStatuses ?? [];
            return containerStatuses.every((cs) => cs.state?.running != null);
        });
        if (running != null) return running;
        await sleep(pollIntervalMs);
    }

    return undefined;
}
