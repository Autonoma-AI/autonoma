import type { SpotPrice } from "@aws-sdk/client-ec2";
import { describe, expect, test } from "vitest";
import {
    averageUsableSpotPrice,
    blendComputeResourceRates,
    deriveComputeResourceRates,
    type OnDemandInstancePrice,
    REFERENCE_COMPUTE_POOLS,
    toCreditRates,
} from "../../src/aws-pricing/aws-instance-pricing";

function instancePrice(overrides: Partial<OnDemandInstancePrice> = {}): OnDemandInstancePrice {
    return {
        instanceType: "m7i.xlarge",
        vcpuCount: 4,
        memoryGb: 16,
        usdPerHour: 0.2016,
        ...overrides,
    };
}

describe("deriveComputeResourceRates", () => {
    test("isolates per-vCPU and per-GB rates from real m7i.xlarge/r7i.xlarge on-demand prices", () => {
        // Fetched from AWS's Price List Query API (us-east-1, Linux, shared tenancy) - same 4
        // vCPU, memory-only difference (16 GB vs 32 GB) isolates the memory cost component.
        const lighter = instancePrice({ instanceType: "m7i.xlarge", vcpuCount: 4, memoryGb: 16, usdPerHour: 0.2016 });
        const heavier = instancePrice({ instanceType: "r7i.xlarge", vcpuCount: 4, memoryGb: 32, usdPerHour: 0.2646 });

        const rates = deriveComputeResourceRates(lighter, heavier);

        expect(rates.usdPerGbHour).toBeCloseTo(0.0039375, 6);
        expect(rates.usdPerVcpuHour).toBeCloseTo(0.03465, 6);
        // The derived rates must reconstruct both original instance prices exactly.
        expect(lighter.vcpuCount * rates.usdPerVcpuHour + lighter.memoryGb * rates.usdPerGbHour).toBeCloseTo(
            lighter.usdPerHour,
            9,
        );
        expect(heavier.vcpuCount * rates.usdPerVcpuHour + heavier.memoryGb * rates.usdPerGbHour).toBeCloseTo(
            heavier.usdPerHour,
            9,
        );
    });

    test("throws when the two instances have different vCPU counts", () => {
        const lighter = instancePrice({ vcpuCount: 4 });
        const heavier = instancePrice({ instanceType: "r7i.2xlarge", vcpuCount: 8, memoryGb: 64, usdPerHour: 0.5 });

        expect(() => deriveComputeResourceRates(lighter, heavier)).toThrow(/different vCPU counts/);
    });

    test("throws when the heavier instance does not actually have more memory", () => {
        const lighter = instancePrice({ memoryGb: 32 });
        const heavier = instancePrice({ instanceType: "m7i.xlarge-2", memoryGb: 16 });

        expect(() => deriveComputeResourceRates(lighter, heavier)).toThrow(/to have more memory/);
    });
});

describe("blendComputeResourceRates", () => {
    const onDemand = { usdPerVcpuHour: 0.03465, usdPerGbHour: 0.0039375 };
    const spot = { usdPerVcpuHour: 0.0125, usdPerGbHour: 0.0015 };

    test("returns the pure on-demand rate at spotFraction 0", () => {
        expect(blendComputeResourceRates(onDemand, spot, 0)).toEqual(onDemand);
    });

    test("returns the pure spot rate at spotFraction 1", () => {
        expect(blendComputeResourceRates(onDemand, spot, 1)).toEqual(spot);
    });

    test("weights proportionally in between", () => {
        const blended = blendComputeResourceRates(onDemand, spot, 0.25);

        expect(blended.usdPerVcpuHour).toBeCloseTo(0.75 * onDemand.usdPerVcpuHour + 0.25 * spot.usdPerVcpuHour, 9);
        expect(blended.usdPerGbHour).toBeCloseTo(0.75 * onDemand.usdPerGbHour + 0.25 * spot.usdPerGbHour, 9);
    });

    test("throws for an out-of-range spotFraction", () => {
        expect(() => blendComputeResourceRates(onDemand, spot, 1.5)).toThrow(/between 0 and 1/);
        expect(() => blendComputeResourceRates(onDemand, spot, -0.1)).toThrow(/between 0 and 1/);
    });
});

function spotPriceEntry(overrides: Partial<SpotPrice> = {}): SpotPrice {
    return {
        AvailabilityZone: "us-east-1a",
        SpotPrice: "0.0625",
        Timestamp: new Date("2026-08-10T00:00:00Z"),
        ...overrides,
    };
}

describe("averageUsableSpotPrice", () => {
    test("averages the latest price across usable AZs", () => {
        const price = averageUsableSpotPrice([
            spotPriceEntry({ AvailabilityZone: "us-east-1a", SpotPrice: "0.05" }),
            spotPriceEntry({ AvailabilityZone: "us-east-1b", SpotPrice: "0.07" }),
            spotPriceEntry({ AvailabilityZone: "us-east-1c", SpotPrice: "0.09" }),
        ]);

        expect(price).toBeCloseTo(0.07, 9);
    });

    test("excludes AZs production has no subnet in, even if AWS returns pricing for them", () => {
        // us-east-1d has no karpenter.sh/discovery: production subnet - a node can never land there.
        const price = averageUsableSpotPrice([
            spotPriceEntry({ AvailabilityZone: "us-east-1a", SpotPrice: "0.05" }),
            spotPriceEntry({ AvailabilityZone: "us-east-1d", SpotPrice: "500" }),
            spotPriceEntry({ AvailabilityZone: "us-east-1f", SpotPrice: "500" }),
        ]);

        expect(price).toBeCloseTo(0.05, 9);
    });

    test("uses only the most recent entry per AZ", () => {
        const price = averageUsableSpotPrice([
            spotPriceEntry({ AvailabilityZone: "us-east-1a", SpotPrice: "0.05", Timestamp: new Date("2026-08-01") }),
            spotPriceEntry({ AvailabilityZone: "us-east-1a", SpotPrice: "0.08", Timestamp: new Date("2026-08-10") }),
        ]);

        expect(price).toBeCloseTo(0.08, 9);
    });

    test("throws when no usable AZ has price history", () => {
        expect(() => averageUsableSpotPrice([spotPriceEntry({ AvailabilityZone: "us-east-1d" })])).toThrow(
            /no spot price history/i,
        );
    });
});

describe("REFERENCE_COMPUTE_POOLS", () => {
    test("previewkit prices the amd64 app pods (resource-factory.ts nodeSelector), not the pool's own arm64 runner nodes", () => {
        const previewkit = REFERENCE_COMPUTE_POOLS.find((pool) => pool.name === "previewkit");

        expect(previewkit?.lighterInstanceType).toBe("m7i.xlarge");
        expect(previewkit?.heavierInstanceType).toBe("r7i.xlarge");
    });
});

describe("toCreditRates", () => {
    test("converts USD resource rates to credits using the given exchange rate", () => {
        const credits = toCreditRates({ usdPerVcpuHour: 0.03465, usdPerGbHour: 0.0039375 }, 1500);

        expect(credits.creditsPerVcpuHour).toBeCloseTo(51.975, 6);
        expect(credits.creditsPerGbMemoryHour).toBeCloseTo(5.90625, 6);
    });
});
