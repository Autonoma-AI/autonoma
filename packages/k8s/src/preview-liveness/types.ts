/**
 * Power/health state of a preview environment, derived purely from Kubernetes
 * workload and pod state - the source of truth the central Gatekeeper itself
 * scales against. Richer than "asleep vs awake" because k8s can tell a healthy
 * preview from one that woke but is crashlooping, which a proxy's power flag
 * cannot.
 *
 * - `asleep`  - scaled to zero by the Gatekeeper idle loop (no pods running).
 * - `waking`  - replicas requested but not all ready yet, no fatal container
 *               state seen. The normal cold-start transient.
 * - `healthy` - every managed workload has its full replica count Ready.
 * - `error`   - a managed workload is broken in a way that will not self-heal
 *               (crashloop, image pull failure, bad config, progress deadline).
 */
export type PreviewPowerState = "asleep" | "waking" | "healthy" | "error";

export type PreviewWorkloadKind = "Deployment" | "StatefulSet";

export interface WorkloadLiveness {
    name: string;
    kind: PreviewWorkloadKind;
    state: PreviewPowerState;
    /**
     * The specific Kubernetes reason when `state` is `error` (e.g.
     * `CrashLoopBackOff`, `ImagePullBackOff`, `ProgressDeadlineExceeded`) or the
     * anomalous `ScaledToZero`. Undefined for the ordinary states.
     */
    reason?: string;
}

export interface NamespaceLiveness {
    namespace: string;
    state: PreviewPowerState;
    workloads: WorkloadLiveness[];
}
