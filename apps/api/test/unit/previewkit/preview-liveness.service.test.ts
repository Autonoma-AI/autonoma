import type { NamespaceLiveness } from "@autonoma/k8s/preview-liveness";
import { describe, expect, it } from "vitest";
import { type FleetSource, PreviewLivenessService } from "../../../src/routes/preview-access/preview-liveness.service";

function fleet(entries: Array<[string, NamespaceLiveness["state"]]>): Map<string, NamespaceLiveness> {
    return new Map(entries.map(([namespace, state]) => [namespace, { namespace, state, workloads: [] }]));
}

class FakeSource implements FleetSource {
    calls = 0;
    result: Map<string, NamespaceLiveness>;
    rejectWith?: Error;

    constructor(result: Map<string, NamespaceLiveness> = new Map()) {
        this.result = result;
    }

    async listFleet(): Promise<Map<string, NamespaceLiveness>> {
        this.calls++;
        if (this.rejectWith != null) throw this.rejectWith;
        return this.result;
    }
}

describe("PreviewLivenessService", () => {
    it("serves a cached snapshot within the TTL, then refetches after it expires", async () => {
        let now = 0;
        const source = new FakeSource(fleet([["preview-a", "healthy"]]));
        const service = new PreviewLivenessService(source, () => now);

        await service.getFleet();
        now = 4_000; // within the 5s TTL
        await service.getFleet();
        expect(source.calls).toBe(1);

        now = 6_000; // past the TTL
        await service.getFleet();
        expect(source.calls).toBe(2);
    });

    it("coalesces concurrent callers into a single cluster read", async () => {
        const source = new FakeSource(fleet([["preview-a", "asleep"]]));
        const service = new PreviewLivenessService(source, () => 0);

        const [a, b] = await Promise.all([service.getFleet(), service.getFleet()]);
        expect(source.calls).toBe(1);
        expect(a).toBe(b);
    });

    it("never throws on a cluster read failure - serves an empty snapshot", async () => {
        const source = new FakeSource();
        source.rejectWith = new Error("cluster unreachable");
        const service = new PreviewLivenessService(source, () => 0);

        const result = await service.getFleet();
        expect(result.size).toBe(0);
    });

    it("serves the last good snapshot when a later refresh fails", async () => {
        let now = 0;
        const source = new FakeSource(fleet([["preview-a", "healthy"]]));
        const service = new PreviewLivenessService(source, () => now);

        await service.getFleet();
        now = 6_000;
        source.rejectWith = new Error("blip");
        const result = await service.getFleet();

        expect(service.stateForNamespace("preview-a", result)).toBe("healthy");
    });

    it("reports unknown for a namespace absent from the snapshot", () => {
        const service = new PreviewLivenessService(new FakeSource(), () => 0);
        expect(service.stateForNamespace("preview-missing", fleet([["preview-a", "healthy"]]))).toBe("unknown");
    });
});
