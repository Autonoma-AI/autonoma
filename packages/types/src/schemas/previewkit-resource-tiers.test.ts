import { describe, expect, it } from "vitest";
import {
    APP_RESOURCE_TIER_NAMES,
    APP_RESOURCE_TIERS,
    parseCpu,
    parseMemory,
    SERVICE_RESOURCE_TIER_NAMES,
    SERVICE_RESOURCE_TIERS,
    snapToResourceTier,
} from "./previewkit-resource-tiers";

function snapApp(cpu: string, memory: string) {
    return snapToResourceTier(APP_RESOURCE_TIERS, APP_RESOURCE_TIER_NAMES, { cpu, memory });
}

function snapService(cpu: string, memory: string) {
    return snapToResourceTier(SERVICE_RESOURCE_TIERS, SERVICE_RESOURCE_TIER_NAMES, { cpu, memory });
}

describe("resource quantity parsing", () => {
    it.each([
        ["150m", 150],
        ["1", 1000],
        ["0.5", 500],
        ["2000m", 2000],
    ])("reads cpu %s as %i millicores", (value, expected) => {
        expect(parseCpu(value)).toBe(expected);
    });

    it.each([
        ["256Mi", 256 * 1024 ** 2],
        ["1Gi", 1024 ** 3],
        ["2048Mi", 2048 * 1024 ** 2],
        ["512M", 512 * 1000 ** 2],
    ])("reads memory %s", (value, expected) => {
        expect(parseMemory(value)).toBe(expected);
    });

    it("returns undefined for something that is not a quantity", () => {
        expect(parseCpu("lots")).toBeUndefined();
        expect(parseMemory("6 gigs")).toBeUndefined();
    });

    /** 2048Mi and 2Gi are the same size written two ways, and must snap identically. */
    it("treats equivalent memory spellings as equal", () => {
        expect(parseMemory("2048Mi")).toBe(parseMemory("2Gi"));
    });
});

describe("snapToResourceTier", () => {
    /**
     * Every distinct pair configured in production when tiers were introduced. If one
     * of these moved DOWN, a running container would start OOM-killing on the next
     * deploy, so the mapping is pinned rather than described.
     */
    it.each([
        ["250m", "1Gi", "medium"],
        ["250m", "512Mi", "standard"],
        ["500m", "512Mi", "large"],
        ["250m", "256Mi", "standard"],
        ["500m", "2048Mi", "xlarge"],
    ])("maps the live app config %s / %s to %s", (cpu, memory, expected) => {
        expect(snapApp(cpu, memory)).toBe(expected);
    });

    it.each([
        ["100m", "1Gi", "standard"],
        ["500m", "1Gi", "large"],
        ["500m", "512Mi", "large"],
        ["500m", "2048Mi", "large"],
        ["250m", "256Mi", "large"],
    ])("maps the live service config %s / %s to %s", (cpu, memory, expected) => {
        expect(snapService(cpu, memory)).toBe(expected);
    });

    /** Both dimensions have to fit, which is what sends a CPU-heavy container up. */
    it("takes the tier that covers cpu even when memory would fit lower", () => {
        expect(snapApp("500m", "128Mi")).toBe("large");
    });

    it("rounds a value between tiers up, never down", () => {
        expect(snapApp("250m", "768Mi")).toBe("medium");
        expect(snapApp("150m", "200Mi")).toBe("small");
    });

    /**
     * Refusing would make a config that is already deployed unparseable, and the
     * deploy path re-parses - so an unreadable config takes down a running preview.
     */
    it("gives the largest tier to a request nothing covers", () => {
        expect(snapApp("8", "64Gi")).toBe("xlarge");
        expect(snapService("8", "64Gi")).toBe("large");
    });

    it("treats an absent value as asking for nothing", () => {
        expect(snapToResourceTier(APP_RESOURCE_TIERS, APP_RESOURCE_TIER_NAMES, {})).toBe("small");
    });

    /** A garbled value must not read as "enormous" and silently cost the largest tier. */
    it("treats an unparseable value as asking for nothing", () => {
        expect(snapApp("nonsense", "nonsense")).toBe("small");
    });
});

describe("the ladders themselves", () => {
    it.each([
        ["app", APP_RESOURCE_TIERS, APP_RESOURCE_TIER_NAMES],
        ["service", SERVICE_RESOURCE_TIERS, SERVICE_RESOURCE_TIER_NAMES],
    ])("names every %s tier exactly once, so snapping cannot skip one", (_label, tiers, names) => {
        expect([...names].sort()).toEqual(Object.keys(tiers).sort());
    });

    it.each([
        ["app", APP_RESOURCE_TIERS, APP_RESOURCE_TIER_NAMES],
        ["service", SERVICE_RESOURCE_TIERS, SERVICE_RESOURCE_TIER_NAMES],
    ])("orders %s tiers smallest to largest, which snapping relies on", (_label, tiers, names) => {
        const sizes = names.map((name) => {
            const tier = tiers[name as keyof typeof tiers];
            return { cpu: parseCpu(tier.cpu) ?? 0, memory: parseMemory(tier.memory) ?? 0 };
        });

        for (let index = 1; index < sizes.length; index++) {
            const previous = sizes[index - 1];
            const current = sizes[index];
            if (previous == null || current == null) throw new Error("unreachable");
            expect(current.cpu).toBeGreaterThanOrEqual(previous.cpu);
            expect(current.memory).toBeGreaterThanOrEqual(previous.memory);
        }
    });
});
