import type { V1Deployment, V1Pod, V1StatefulSet } from "@kubernetes/client-node";
import type { NamespaceLiveness, PreviewPowerState, PreviewWorkloadKind, WorkloadLiveness } from "./types";

// The label the deployer stamps on every preview workload (resource-factory.ts
// BASE_LABELS) and that the central Gatekeeper sleeps/wakes on (its
// TARGET_SELECTOR). Selecting on it returns exactly the set of workloads whose
// collective readiness means "this preview is usable".
export const PREVIEW_MANAGED_LABEL = "previewkit.dev/managed-by";
export const PREVIEW_MANAGED_LABEL_VALUE = "previewkit";
export const PREVIEW_MANAGED_LABEL_SELECTOR = `${PREVIEW_MANAGED_LABEL}=${PREVIEW_MANAGED_LABEL_VALUE}`;

// Written by Gatekeeper onto each workload it sleeps, carrying the pre-sleep
// replica count. Its presence alongside replicas:0 is Gatekeeper's fingerprint,
// distinguishing an intentional scale-to-zero from an anomalous one.
const WAKE_REPLICAS_ANNOTATION = "gatekeeper.dev/wake-replicas";

// A container that has restarted at least this many times AND is currently
// backing off (waiting) is crashlooping, whatever the runtime named the reason.
const CRASHLOOP_RESTART_THRESHOLD = 3;

// Container `waiting.reason` is a FREE-FORM string set by the kubelet/CRI
// runtime - the client-node type is `string`, not an enum, and the set of
// reasons changes across Kubernetes versions and runtimes. So this list can
// never be provably exhaustive; it is a fast-path allowlist of the well-known
// terminal reasons (from kubelet's image/container managers). Two version-stable
// backstops catch anything it misses, including future or renamed reasons:
//   - restartCount >= CRASHLOOP_RESTART_THRESHOLD while waiting (see below), and
//   - the Deployment's `ProgressDeadlineExceeded` condition (a real API enum),
//     handled in the workload view.
// A Set behind a predicate so a new reason is one entry and call sites ask
// membership by name (never scan an array). The names are also exported as a
// tuple: callers that give each reason its own treatment (the user-facing
// explanation of a failed rollout) key a Record off `FatalWaitingReason`, so
// adding a reason here is a compile error there rather than a silent fallback.
export const FATAL_WAITING_REASON_NAMES = [
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "ErrImageNeverPull",
    "InvalidImageName",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
] as const;

export type FatalWaitingReason = (typeof FATAL_WAITING_REASON_NAMES)[number];

const FATAL_WAITING_REASONS: ReadonlySet<string> = new Set(FATAL_WAITING_REASON_NAMES);

export function isFatalWaitingReason(reason: string | undefined): reason is FatalWaitingReason {
    return reason != null && FATAL_WAITING_REASONS.has(reason);
}

/**
 * The fatal reason named inside a free-text failure message, if any.
 *
 * The sibling of {@link isFatalWaitingReason}, for callers holding prose rather than a pod. The
 * deployer formats its verdict as a sentence (`pod <name> container <name> is in <reason>: ...`)
 * and stores that string, so anything reading it back out of the database - rather than off a live
 * pod - has only the text. Kept here, beside the vocabulary and the structural extractor, so
 * "which reasons exist and how do I spot one" is answered in exactly one module however the caller
 * happens to be holding the failure.
 *
 * Scanned in declaration order and by substring, because the reason arrives embedded in that
 * sentence rather than as a bare field.
 */
export function fatalReasonFromMessage(message: string | undefined): FatalWaitingReason | undefined {
    if (message == null) return undefined;
    return FATAL_WAITING_REASON_NAMES.find((reason) => message.includes(reason));
}

export interface NamespaceWorkloads {
    namespace: string;
    deployments: V1Deployment[];
    statefulSets: V1StatefulSet[];
    pods: V1Pod[];
}

/**
 * Derives a preview namespace's power/health state from its managed workloads
 * and their pods. Pure: no I/O, no waking - given the same objects it always
 * returns the same verdict, which is what lets the kind integration tests pin it
 * against real API responses.
 */
export function classifyNamespace(input: NamespaceWorkloads): NamespaceLiveness {
    const workloads: WorkloadLiveness[] = [
        ...input.deployments.map((d) => classifyWorkload(deploymentView(d), input.pods)),
        ...input.statefulSets.map((s) => classifyWorkload(statefulSetView(s), input.pods)),
    ];

    return {
        namespace: input.namespace,
        state: rollup(workloads),
        workloads,
    };
}

// A workload's power state is the worst of its parts: one broken workload makes
// the whole preview unusable, and a preview is only fully asleep or fully
// healthy when EVERY workload is. Anything in between (some awake, some asleep,
// some not-yet-ready) is still waking.
function rollup(workloads: WorkloadLiveness[]): PreviewPowerState {
    if (workloads.length === 0) return "error";
    if (workloads.some((w) => w.state === "error")) return "error";
    if (workloads.every((w) => w.state === "asleep")) return "asleep";
    if (workloads.every((w) => w.state === "healthy")) return "healthy";
    return "waking";
}

interface WorkloadView {
    name: string;
    kind: PreviewWorkloadKind;
    desiredReplicas: number;
    readyReplicas: number;
    hasWakeReplicasAnnotation: boolean;
    progressDeadlineExceeded: boolean;
    selector: Record<string, string>;
}

function classifyWorkload(view: WorkloadView, allPods: V1Pod[]): WorkloadLiveness {
    const base = { name: view.name, kind: view.kind };

    // Scaled to zero: asleep only if Gatekeeper put it there (its wake-replicas
    // annotation). Replicas:0 without that fingerprint is abnormal for a preview
    // - surface it as an error rather than silently reporting "asleep".
    if (view.desiredReplicas === 0) {
        if (view.hasWakeReplicasAnnotation) return { ...base, state: "asleep" };
        return { ...base, state: "error", reason: "ScaledToZero" };
    }

    // Error beats "still waking": a fatal container state will not fix itself,
    // so it must not read as a cold-start that a caller would wait out.
    const pods = allPods.filter((pod) => podMatchesSelector(pod, view.selector));
    const fatalReason = firstFatalReason(pods);
    if (fatalReason != null) return { ...base, state: "error", reason: fatalReason };
    if (view.progressDeadlineExceeded) return { ...base, state: "error", reason: "ProgressDeadlineExceeded" };

    if (view.readyReplicas >= view.desiredReplicas) return { ...base, state: "healthy" };
    return { ...base, state: "waking" };
}

function deploymentView(deployment: V1Deployment): WorkloadView {
    const progressing = deployment.status?.conditions?.find((c) => c.type === "Progressing");
    return {
        name: deployment.metadata?.name ?? "",
        kind: "Deployment",
        desiredReplicas: deployment.spec?.replicas ?? 1,
        readyReplicas: deployment.status?.readyReplicas ?? 0,
        hasWakeReplicasAnnotation: hasWakeAnnotation(deployment.metadata?.annotations),
        progressDeadlineExceeded: progressing?.reason === "ProgressDeadlineExceeded",
        selector: deployment.spec?.selector?.matchLabels ?? {},
    };
}

function statefulSetView(statefulSet: V1StatefulSet): WorkloadView {
    return {
        name: statefulSet.metadata?.name ?? "",
        kind: "StatefulSet",
        desiredReplicas: statefulSet.spec?.replicas ?? 1,
        readyReplicas: statefulSet.status?.readyReplicas ?? 0,
        hasWakeReplicasAnnotation: hasWakeAnnotation(statefulSet.metadata?.annotations),
        // StatefulSets have no Progressing condition; a stuck rollout surfaces
        // through pod container state, which the fatal-reason check catches.
        progressDeadlineExceeded: false,
        selector: statefulSet.spec?.selector?.matchLabels ?? {},
    };
}

function hasWakeAnnotation(annotations: Record<string, string> | undefined): boolean {
    return annotations != null && WAKE_REPLICAS_ANNOTATION in annotations;
}

// A pod belongs to a workload when its labels are a superset of the workload's
// selector - the same match Kubernetes itself uses. Avoids walking the
// pod -> ReplicaSet -> Deployment owner chain just to group pods.
function podMatchesSelector(pod: V1Pod, selector: Record<string, string>): boolean {
    const labels = pod.metadata?.labels ?? {};
    const entries = Object.entries(selector);
    if (entries.length === 0) return false;
    return entries.every(([key, value]) => labels[key] === value);
}

// The first fatal reason across a pod set's app AND init containers. Init
// containers matter: a crashlooping init container wedges the pod before any app
// container ever starts, and only shows up in initContainerStatuses.
//
// A container is fatal when either its waiting reason is a known-terminal one,
// OR it has restarted past the crashloop threshold and is currently backing off
// - the second catches a crashloop under any reason string the allowlist does
// not know, so a runtime/version change can never silently downgrade a broken
// preview to "waking".
function firstFatalReason(pods: V1Pod[]): string | undefined {
    for (const pod of pods) {
        const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
        for (const status of statuses) {
            const reason = status.state?.waiting?.reason;
            if (isFatalWaitingReason(reason)) return reason;

            const isBackingOff = status.state?.waiting != null;
            if (isBackingOff && status.restartCount >= CRASHLOOP_RESTART_THRESHOLD) {
                return reason ?? "CrashLoopBackOff";
            }
        }
    }
    return undefined;
}
