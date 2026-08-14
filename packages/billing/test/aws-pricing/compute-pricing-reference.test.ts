import { describe, expect, test } from "vitest";
import { toComputePricingReferenceData } from "../../src/aws-pricing/compute-pricing-reference.service";
import type { ResolvedComputeRates } from "../../src/aws-pricing/resolve-compute-rates";

function resolved(overrides: Partial<ResolvedComputeRates> = {}): ResolvedComputeRates {
    return {
        onDemand: {
            lighter: { instanceType: "m7i.xlarge", vcpuCount: 4, memoryGb: 16, usdPerHour: 0.2 },
            heavier: { instanceType: "r7i.xlarge", vcpuCount: 4, memoryGb: 32, usdPerHour: 0.26 },
            rates: { usdPerVcpuHour: 0.03, usdPerGbHour: 0.004 },
        },
        rates: { usdPerVcpuHour: 0.03, usdPerGbHour: 0.004 },
        ...overrides,
    };
}

describe("toComputePricingReferenceData", () => {
    test("carries the real spot fraction/sample size when a blended rate is available", () => {
        const data = toComputePricingReferenceData(
            resolved({
                spot: {
                    rates: { usdPerVcpuHour: 0.01, usdPerGbHour: 0.001 },
                    capacityMix: { spotFraction: 0.4, sampleSize: 25 },
                },
            }),
        );

        expect(data.spotFraction).toBe(0.4);
        expect(data.sampleSize).toBe(25);
    });

    // The bug this guards: a naive `resolved.spot?.capacityMix.spotFraction` is `undefined` here,
    // and Prisma treats `undefined` in an `update` as "leave the stored column untouched" - so a
    // fallback to on-demand-only would silently keep whatever spotFraction/sampleSize an EARLIER,
    // genuinely-blended sync had stored, misrepresenting these fresh on-demand rates as blended.
    test("clears spotFraction/sampleSize to null when falling back to on-demand-only (no blended rate)", () => {
        const data = toComputePricingReferenceData(resolved());

        expect(data.spotFraction).toBeNull();
        expect(data.sampleSize).toBeNull();
    });

    test("preserves a real 0 spotFraction rather than treating it as absent", () => {
        const data = toComputePricingReferenceData(
            resolved({
                spot: {
                    rates: { usdPerVcpuHour: 0.01, usdPerGbHour: 0.001 },
                    capacityMix: { spotFraction: 0, sampleSize: 10 },
                },
            }),
        );

        expect(data.spotFraction).toBe(0);
        expect(data.sampleSize).toBe(10);
    });
});
