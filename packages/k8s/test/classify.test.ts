import type { V1Deployment, V1Pod, V1StatefulSet } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { classifyNamespace } from "../src/preview-liveness/classify";

const APP_SELECTOR = { app: "web" };

function deployment(overrides: {
    name?: string;
    replicas?: number;
    readyReplicas?: number;
    annotations?: Record<string, string>;
    progressDeadlineExceeded?: boolean;
    selector?: Record<string, string>;
}): V1Deployment {
    return {
        metadata: { name: overrides.name ?? "web", namespace: "preview", annotations: overrides.annotations },
        spec: {
            replicas: overrides.replicas ?? 1,
            selector: { matchLabels: overrides.selector ?? APP_SELECTOR },
            template: {},
        },
        status: {
            readyReplicas: overrides.readyReplicas ?? 0,
            conditions: overrides.progressDeadlineExceeded
                ? [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }]
                : [],
        },
    };
}

function pod(overrides: {
    labels?: Record<string, string>;
    waitingReason?: string;
    initWaitingReason?: string;
    restartCount?: number;
    running?: boolean;
}): V1Pod {
    const restartCount = overrides.restartCount ?? 0;
    const runningContainer = {
        name: "web",
        image: "img",
        imageID: "",
        ready: true,
        restartCount,
        state: { running: { startedAt: new Date(0) } },
    };
    const container = overrides.running
        ? runningContainer
        : overrides.waitingReason != null
          ? containerStatus("web", overrides.waitingReason, restartCount)
          : undefined;
    return {
        metadata: { name: "web-abc", namespace: "preview", labels: overrides.labels ?? { app: "web" } },
        status: {
            initContainerStatuses:
                overrides.initWaitingReason != null
                    ? [containerStatus("init", overrides.initWaitingReason, restartCount)]
                    : undefined,
            containerStatuses: container != null ? [container] : [],
        },
    };
}

function containerStatus(name: string, waitingReason: string, restartCount = 0) {
    return {
        name,
        image: "img",
        imageID: "",
        ready: false,
        restartCount,
        state: { waiting: { reason: waitingReason } },
    };
}

function classify(deployments: V1Deployment[], pods: V1Pod[] = [], statefulSets: V1StatefulSet[] = []) {
    return classifyNamespace({ namespace: "preview", deployments, statefulSets, pods });
}

describe("classifyNamespace", () => {
    it("reports asleep when scaled to zero with the wake-replicas annotation", () => {
        const result = classify([deployment({ replicas: 0, annotations: { "gatekeeper.dev/wake-replicas": "1" } })]);
        expect(result.state).toBe("asleep");
    });

    it("reports error when scaled to zero WITHOUT the gatekeeper fingerprint", () => {
        const result = classify([deployment({ replicas: 0 })]);
        expect(result.state).toBe("error");
        expect(result.workloads[0]?.reason).toBe("ScaledToZero");
    });

    it("reports healthy when readyReplicas meets desired", () => {
        expect(classify([deployment({ replicas: 1, readyReplicas: 1 })]).state).toBe("healthy");
    });

    it("reports waking when replicas are requested but not yet ready", () => {
        expect(classify([deployment({ replicas: 1, readyReplicas: 0 })]).state).toBe("waking");
    });

    it("reports error on a crashlooping container", () => {
        const result = classify(
            [deployment({ replicas: 1, readyReplicas: 0 })],
            [pod({ waitingReason: "CrashLoopBackOff" })],
        );
        expect(result.state).toBe("error");
        expect(result.workloads[0]?.reason).toBe("CrashLoopBackOff");
    });

    it("reports error on an image pull failure", () => {
        const result = classify([deployment({ replicas: 1 })], [pod({ waitingReason: "ImagePullBackOff" })]);
        expect(result.workloads[0]?.reason).toBe("ImagePullBackOff");
    });

    it("flags a crashloop under an UNKNOWN waiting reason via restart count", () => {
        // A reason the fatal allowlist does not know (a future / runtime-specific
        // name) still reads as error once the container is looping.
        const result = classify(
            [deployment({ replicas: 1, readyReplicas: 0 })],
            [pod({ waitingReason: "SomeNewRuntimeReason", restartCount: 5 })],
        );
        expect(result.state).toBe("error");
        expect(result.workloads[0]?.reason).toBe("SomeNewRuntimeReason");
    });

    it("does not flag a container that restarted but has since recovered", () => {
        // High restart count but currently Running and Ready - not backing off.
        const result = classify(
            [deployment({ replicas: 1, readyReplicas: 1 })],
            [pod({ running: true, restartCount: 10 })],
        );
        expect(result.state).toBe("healthy");
    });

    it("reports error when the progress deadline is exceeded", () => {
        const result = classify([deployment({ replicas: 1, readyReplicas: 0, progressDeadlineExceeded: true })]);
        expect(result.state).toBe("error");
        expect(result.workloads[0]?.reason).toBe("ProgressDeadlineExceeded");
    });

    it("catches a fatal init container that wedges the pod before app containers start", () => {
        const result = classify(
            [deployment({ replicas: 1 })],
            [pod({ initWaitingReason: "CreateContainerConfigError" })],
        );
        expect(result.workloads[0]?.reason).toBe("CreateContainerConfigError");
    });

    it("ignores pods that do not match the workload selector", () => {
        // A crashlooping pod for a DIFFERENT app must not taint this workload.
        const result = classify(
            [deployment({ replicas: 1, readyReplicas: 1 })],
            [pod({ labels: { app: "other" }, waitingReason: "CrashLoopBackOff" })],
        );
        expect(result.state).toBe("healthy");
    });

    it("rolls a namespace up to error when any workload is broken", () => {
        const result = classify([
            deployment({ name: "web", replicas: 1, readyReplicas: 1 }),
            deployment({ name: "broken", replicas: 0 }),
        ]);
        expect(result.state).toBe("error");
    });

    it("rolls up to asleep only when every workload is asleep", () => {
        const asleep = { replicas: 0, annotations: { "gatekeeper.dev/wake-replicas": "1" } };
        expect(classify([deployment({ name: "web", ...asleep }), deployment({ name: "db", ...asleep })]).state).toBe(
            "asleep",
        );
    });

    it("rolls a partially-woken namespace up to waking, not asleep", () => {
        const asleep = deployment({ name: "db", replicas: 0, annotations: { "gatekeeper.dev/wake-replicas": "1" } });
        const waking = deployment({ name: "web", replicas: 1, readyReplicas: 0 });
        expect(classify([asleep, waking]).state).toBe("waking");
    });
});
