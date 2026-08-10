import type { WorkloadLiveness } from "@autonoma/k8s/preview-liveness";
import { describe, expect, it } from "vitest";
import { resolveServiceStatus } from "../../../src/routes/onboarding/preview-readiness";

const workload = (state: WorkloadLiveness["state"], reason?: string): WorkloadLiveness => ({
    name: "db",
    kind: "StatefulSet",
    state,
    ...(reason != null ? { reason } : {}),
});

describe("resolveServiceStatus", () => {
    it("keeps the pipeline's verdict while the cluster has nothing to say", () => {
        // Mid-deploy the workload does not exist yet. This is the common case during
        // onboarding, and the reason the cluster is an overlay rather than a replacement.
        expect(resolveServiceStatus("building", undefined)).toEqual({
            status: "building",
            statusSource: "pipeline",
        });
        expect(resolveServiceStatus("ready", undefined)).toEqual({ status: "ready", statusSource: "pipeline" });
    });

    it("reports a crashlooping service as failed even though its deploy succeeded", () => {
        // The reported gap: the pipeline can only say it handed the workload over, so
        // a database that accepted its manifest and then died still read as ready.
        expect(resolveServiceStatus("ready", workload("error", "CrashLoopBackOff"))).toEqual({
            status: "failed",
            statusSource: "cluster",
            error: "CrashLoopBackOff",
        });
    });

    it("falls back to a plain reason when Kubernetes gave none", () => {
        expect(resolveServiceStatus("ready", workload("error"))).toEqual({
            status: "failed",
            statusSource: "cluster",
            error: "The workload is not staying up.",
        });
    });

    it("only calls a service ready once its replicas are actually ready", () => {
        expect(resolveServiceStatus("ready", workload("healthy"))).toEqual({
            status: "ready",
            statusSource: "cluster",
        });
        expect(resolveServiceStatus("ready", workload("waking"))).toEqual({
            status: "building",
            statusSource: "cluster",
        });
    });

    it("reads a scaled-to-zero preview as idle, not as failed", () => {
        // Asleep is the Gatekeeper doing its job on a healthy preview. Reporting it as
        // failed would send a user chasing a problem that does not exist.
        expect(resolveServiceStatus("ready", workload("asleep"))).toEqual({
            status: "idle",
            statusSource: "cluster",
        });
    });

    it("lets the cluster correct a pipeline verdict in either direction", () => {
        // A deploy the pipeline gave up on whose pod is in fact serving.
        expect(resolveServiceStatus("failed", workload("healthy"))).toEqual({
            status: "ready",
            statusSource: "cluster",
        });
    });
});
