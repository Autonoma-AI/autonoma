import type { V1Pod } from "@kubernetes/client-node";

/**
 * Container `state.waiting.reason` values that mean a pod will not reach Ready
 * without a change to its image or spec - so the deployer should fail fast with
 * a precise reason instead of waiting out the full deploy timeout.
 *
 * `ErrImagePull` is deliberately NOT included: it is the FIRST pull failure and
 * the kubelet may still succeed on retry (e.g. an image just pushed to ECR that
 * is still propagating). Once the kubelet gives up and backs off, the reason
 * becomes `ImagePullBackOff`, which IS terminal and is in the set - so excluding
 * `ErrImagePull` buys a one-retry grace period for free.
 */
const TERMINAL_WAITING_REASONS = new Set([
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "InvalidImageName",
    "CreateContainerConfigError",
    "CreateContainerError",
]);

/**
 * Scans the pods behind a workload for a container in a terminal waiting state
 * (see TERMINAL_WAITING_REASONS) and returns a human-readable reason carrying
 * the offending pod/container, the reason, and the kubelet message (e.g. the
 * image that could not be pulled).
 *
 * Returns undefined while every pod is still legitimately progressing toward
 * Ready - `ContainerCreating`, a first-attempt `ErrImagePull`, or an
 * unschedulable `Pending` whose node Karpenter may still be provisioning. Those
 * states are bounded by the caller's deploy timeout, not failed early.
 *
 * The returned string preserves the literal k8s reason (e.g. "CrashLoopBackOff")
 * so callers can still classify the failure downstream by substring.
 */
export function findTerminalPodFailure(pods: V1Pod[]): string | undefined {
    for (const pod of pods) {
        const podName = pod.metadata?.name ?? "unknown";
        for (const cs of pod.status?.containerStatuses ?? []) {
            const waiting = cs.state?.waiting;
            if (waiting?.reason == null || !TERMINAL_WAITING_REASONS.has(waiting.reason)) continue;
            const detail = waiting.message != null && waiting.message !== "" ? `: ${waiting.message}` : "";
            return `pod ${podName} container ${cs.name} is in ${waiting.reason}${detail}`;
        }
    }
    return undefined;
}

/**
 * Compact one-line-per-pod diagnostic - phase, any waiting/terminated container
 * reasons, and a scheduling failure message - for embedding in a readiness
 * timeout error (so the reason reaches the PR comment and DB, not just the logs).
 */
export function summarizePodStates(pods: V1Pod[]): string {
    if (pods.length === 0) return "no pods found";
    return pods
        .map((pod) => {
            const name = pod.metadata?.name ?? "unknown";
            const phase = pod.status?.phase ?? "unknown";
            const parts = [`${name} (${phase})`];

            const containerIssues = (pod.status?.containerStatuses ?? [])
                .map((cs) => {
                    if (cs.state?.waiting?.reason != null) return `${cs.name}:${cs.state.waiting.reason}`;
                    const terminated = cs.state?.terminated;
                    if (terminated?.reason != null)
                        return `${cs.name}:${terminated.reason}(exit ${terminated.exitCode})`;
                    return undefined;
                })
                .filter((issue): issue is string => issue != null);
            if (containerIssues.length > 0) parts.push(`containers=[${containerIssues.join(", ")}]`);

            const unschedulable = pod.status?.conditions?.find(
                (c) => c.type === "PodScheduled" && c.status === "False",
            );
            if (unschedulable?.message != null) parts.push(`unschedulable=${unschedulable.message}`);

            return parts.join(" ");
        })
        .join("; ");
}
