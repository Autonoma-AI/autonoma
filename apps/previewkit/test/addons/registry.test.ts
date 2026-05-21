import { describe, expect, it } from "vitest";
import type { AddonProvider, DeprovisionInput, ProvisionInput, ProvisionResult } from "../../src/addons/provider";
import { AddonProviderRegistry } from "../../src/addons/registry";

class FakeProvider implements AddonProvider {
    constructor(public readonly name: string) {}
    async provision(_input: ProvisionInput): Promise<ProvisionResult> {
        return { outputs: {}, state: {} };
    }
    async deprovision(_input: DeprovisionInput): Promise<void> {}
}

describe("AddonProviderRegistry", () => {
    it("registers and looks up providers by name", () => {
        const registry = new AddonProviderRegistry();
        const neon = new FakeProvider("neon");
        registry.register(neon);
        expect(registry.get("neon")).toBe(neon);
        expect(registry.has("neon")).toBe(true);
    });

    it("throws on duplicate registration to catch wiring mistakes", () => {
        const registry = new AddonProviderRegistry();
        registry.register(new FakeProvider("neon"));
        expect(() => registry.register(new FakeProvider("neon"))).toThrow(/already registered/);
    });

    it("throws on unknown provider with a list of registered names", () => {
        const registry = new AddonProviderRegistry();
        registry.register(new FakeProvider("neon"));
        registry.register(new FakeProvider("planetscale"));
        expect(() => registry.get("upstash")).toThrow(/Unknown addon provider/);
        expect(() => registry.get("upstash")).toThrow(/neon, planetscale/);
    });

    it("reports (none) when nothing is registered", () => {
        const registry = new AddonProviderRegistry();
        expect(() => registry.get("anything")).toThrow(/Available: \(none\)/);
    });
});
