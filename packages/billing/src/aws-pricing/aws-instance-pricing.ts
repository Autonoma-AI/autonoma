import type { Logger } from "@autonoma/logger";
import { _InstanceType, DescribeSpotPriceHistoryCommand, EC2Client, type SpotPrice } from "@aws-sdk/client-ec2";
import { GetProductsCommand, PricingClient } from "@aws-sdk/client-pricing";
import { z } from "zod";
import type { BillingPricingValues } from "../billing-pricing.types";

// The AWS Price List Query API is served only from these two regions, regardless of which
// region's prices are being queried - the priced region is the `location` filter value (a
// human-readable AWS region name, e.g. "US East (N. Virginia)"), not a region code, and not
// this client region.
const PRICING_API_REGION = "us-east-1";

export const AWS_PRICING_LOCATION_US_EAST_1 = "US East (N. Virginia)";
// Unlike the Pricing API, EC2's spot-price history is a genuinely regional API - this is the
// real AWS region code the previewkit/buildkit clusters run in (see the EKS cluster ARNs).
export const AWS_EC2_REGION_US_EAST_1 = "us-east-1";

// The only AZs any buildkit/previewkit subnet actually lives in (the `karpenter.sh/discovery:
// production` subnet tag - see deployment/karpenter/node-class/buildkit.yaml). DescribeSpotPriceHistory
// returns pricing for EVERY AZ in the region regardless of whether this account has capacity there -
// us-east-1 also has 1d/1e/1f - so averaging the raw response would price AZs Karpenter can never
// actually place a node in.
const PRODUCTION_USABLE_AVAILABILITY_ZONES: ReadonlySet<string> = new Set(["us-east-1a", "us-east-1b", "us-east-1c"]);

/** The SDK exports this union of every valid EC2 instance type under an awkward leading-underscore name. */
export type Ec2InstanceType = _InstanceType;

const VALID_EC2_INSTANCE_TYPES: ReadonlySet<string> = new Set(Object.values(_InstanceType));

/**
 * Whether a freeform string - e.g. read off a Kubernetes node's `node.kubernetes.io/instance-type`
 * label - is a real EC2 instance type the pinned AWS SDK version knows about. The boundary check
 * needed before passing a live-observed value (not one of our own compile-time reference
 * literals) into `fetchSpotPrice`/`fetchOnDemandInstancePrice`, both of which require an actual
 * instance type - validated against the SDK's own runtime enum rather than a hand-maintained
 * list, so it never drifts from whatever AWS SDK version is actually installed.
 */
export function isEc2InstanceType(value: string): value is Ec2InstanceType {
    return VALID_EC2_INSTANCE_TYPES.has(value);
}

export interface ComputePoolReference {
    name: string;
    source: string;
    lighterInstanceType: Ec2InstanceType;
    heavierInstanceType: Ec2InstanceType;
    /**
     * Whether this pool's Karpenter NodePool allows spot capacity (`karpenter.sh/capacity-type`).
     * Buildkit does (`spot` or `on-demand`); previewkit is restricted to `on-demand` only. Only
     * spot-eligible pools need a blended rate - forcing one on an on-demand-only pool would just
     * be extra AWS calls for a fraction that's always 0.
     */
    supportsSpot: boolean;
}

// One reference pair per Karpenter compute pool - same vCPU count, different memory, so
// `deriveComputeResourceRates` can isolate a per-vCPU and per-GB rate for that pool's actual
// architecture/family. Update these if the pools' instance-category/generation requirements
// change - see deployment/karpenter/node-pool/buildkit.yaml. Shared between the manual CLI
// (derive-compute-pricing-cli.ts) and the scheduled drift check
// (apps/cronjobs/scripts/aws-compute-pricing-drift), so both always compare the same instances.
export const REFERENCE_COMPUTE_POOLS: readonly ComputePoolReference[] = [
    {
        name: "buildkit",
        source: "deployment/karpenter/node-pool/buildkit.yaml (m-family, gen 6-8, xlarge, amd64)",
        lighterInstanceType: "m7i.xlarge",
        heavierInstanceType: "r7i.xlarge",
        supportsSpot: true,
    },
    {
        // This prices the BILLABLE workload - the deployed preview app pods, pinned to amd64 by
        // `resource-factory.ts`'s `nodeSelector: { "kubernetes.io/arch": "amd64" }` - not the
        // isolated `previewkit` Karpenter NodePool (deployment/karpenter/node-pool/previewkit.yaml),
        // which is arm64 but only ever hosts the one-shot runner Job that ORCHESTRATES a deploy, never
        // the customer's own app containers. Those app pods have no dedicated pool/fixed shape of
        // their own, so m7i/r7i (the same general m-family gen7 xlarge amd64 pair as buildkit) stands
        // in as a representative on-demand rate rather than a literal single node's cost.
        name: "previewkit",
        source: "apps/previewkit/src/deployer/resource-factory.ts (amd64 app pods, no dedicated pool)",
        lighterInstanceType: "m7i.xlarge",
        heavierInstanceType: "r7i.xlarge",
        supportsSpot: false,
    },
];

const AwsPriceListEntrySchema = z.object({
    product: z.object({
        attributes: z.object({
            vcpu: z.string(),
            memory: z.string(),
        }),
    }),
    terms: z.object({
        OnDemand: z.record(
            z.string(),
            z.object({
                priceDimensions: z.record(
                    z.string(),
                    z.object({
                        pricePerUnit: z.object({ USD: z.string() }),
                    }),
                ),
            }),
        ),
    }),
});

export interface OnDemandInstancePrice {
    instanceType: string;
    vcpuCount: number;
    memoryGb: number;
    usdPerHour: number;
}

/**
 * Fetches an EC2 instance type's on-demand, Linux, shared-tenancy hourly price from AWS's
 * Price List Query API. Used to derive real compute pricing for Previewkit build/running
 * usage instead of guessing a number - see `deriveComputeResourceRates`.
 */
export async function fetchOnDemandInstancePrice(
    instanceType: string,
    awsLocation: string,
    logger: Logger,
): Promise<OnDemandInstancePrice> {
    logger.info("Fetching AWS on-demand instance price", { extra: { instanceType, awsLocation } });

    const client = new PricingClient({ region: PRICING_API_REGION });
    const response = await client.send(
        new GetProductsCommand({
            ServiceCode: "AmazonEC2",
            Filters: [
                { Type: "TERM_MATCH", Field: "instanceType", Value: instanceType },
                { Type: "TERM_MATCH", Field: "location", Value: awsLocation },
                { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
                { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
                { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
                { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" },
            ],
        }),
    );

    const rawEntry = response.PriceList?.[0];
    if (rawEntry == null) {
        throw new Error(`No AWS pricing found for ${instanceType} in ${awsLocation}`);
    }

    const entry = AwsPriceListEntrySchema.parse(JSON.parse(rawEntry));
    const onDemandTerm = Object.values(entry.terms.OnDemand)[0];
    const priceDimension = onDemandTerm != null ? Object.values(onDemandTerm.priceDimensions)[0] : undefined;
    if (priceDimension == null) {
        throw new Error(`No on-demand price dimension found for ${instanceType} in ${awsLocation}`);
    }

    const result = {
        instanceType,
        vcpuCount: Number(entry.product.attributes.vcpu),
        memoryGb: parseMemoryGb(entry.product.attributes.memory),
        usdPerHour: Number(priceDimension.pricePerUnit.USD),
    };

    logger.info("Fetched AWS on-demand instance price", { extra: result });
    return result;
}

function parseMemoryGb(memory: string): number {
    const match = /^([\d.]+)\s*GiB$/.exec(memory);
    if (match == null) throw new Error(`Unrecognized AWS memory attribute format: "${memory}"`);
    return Number(match[1]);
}

export type ComputeResourceRates = Pick<BillingPricingValues, "creditsPerVcpuHour" | "creditsPerGbMemoryHour">;

export interface UsdComputeRates {
    usdPerVcpuHour: number;
    usdPerGbHour: number;
}

/**
 * Decomposes two same-vCPU, different-memory on-demand instance prices into independent
 * USD-per-vCPU-hour and USD-per-GB-hour rates - AWS never publishes a CPU/memory price
 * split directly, so this is the same two-point technique cost-allocation tools like
 * OpenCost/Kubecost use: with vCPU count held constant, the price difference between the
 * two instances is attributable entirely to their memory difference.
 */
export function deriveComputeResourceRates(
    lighter: OnDemandInstancePrice,
    heavier: OnDemandInstancePrice,
): UsdComputeRates {
    if (lighter.vcpuCount !== heavier.vcpuCount) {
        throw new Error(
            `Cannot derive resource rates from instances with different vCPU counts (${lighter.instanceType}: ${lighter.vcpuCount} vCPU, ${heavier.instanceType}: ${heavier.vcpuCount} vCPU)`,
        );
    }
    if (heavier.memoryGb <= lighter.memoryGb) {
        throw new Error(
            `Expected ${heavier.instanceType} (${heavier.memoryGb} GB) to have more memory than ${lighter.instanceType} (${lighter.memoryGb} GB) to isolate the per-GB rate`,
        );
    }

    const usdPerGbHour = (heavier.usdPerHour - lighter.usdPerHour) / (heavier.memoryGb - lighter.memoryGb);
    const usdPerVcpuHour = (lighter.usdPerHour - lighter.memoryGb * usdPerGbHour) / lighter.vcpuCount;

    return { usdPerVcpuHour, usdPerGbHour };
}

/**
 * Averages the most recent price per usable Availability Zone out of a raw
 * `DescribeSpotPriceHistory` response - the pure part of {@link fetchSpotPrice}, split out so it's
 * testable without an AWS client. AZs outside {@link PRODUCTION_USABLE_AVAILABILITY_ZONES} are
 * dropped before averaging: Karpenter can only land in a subnet's AZ, so an AZ the account has no
 * subnet in would misrepresent what the pool actually pays. Only the most recent entry per AZ is
 * used (spot prices adjust gradually over days now, not by the minute, but each AZ still has its
 * own independent history).
 */
export function averageUsableSpotPrice(history: readonly SpotPrice[]): number {
    const latestPriceByAz = new Map<string, { price: number; timestampMs: number }>();
    for (const entry of history) {
        const az = entry.AvailabilityZone;
        const price = entry.SpotPrice;
        const timestamp = entry.Timestamp;
        if (az == null || price == null || timestamp == null) continue;
        if (!PRODUCTION_USABLE_AVAILABILITY_ZONES.has(az)) continue;

        const timestampMs = timestamp.getTime();
        const existing = latestPriceByAz.get(az);
        if (existing == null || timestampMs > existing.timestampMs) {
            latestPriceByAz.set(az, { price: Number(price), timestampMs });
        }
    }

    const prices = [...latestPriceByAz.values()].map((entry) => entry.price);
    if (prices.length === 0) {
        throw new Error("No spot price history found in any usable Availability Zone");
    }
    return prices.reduce((sum, price) => sum + price, 0) / prices.length;
}

/**
 * Fetches an EC2 instance type's current spot price (USD/hour), averaged across the
 * Availability Zones production actually has capacity in (see {@link averageUsableSpotPrice}).
 */
export async function fetchSpotPrice(instanceType: Ec2InstanceType, region: string, logger: Logger): Promise<number> {
    logger.info("Fetching AWS spot price", { extra: { instanceType, region } });

    const client = new EC2Client({ region });
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const response = await client.send(
        new DescribeSpotPriceHistoryCommand({
            InstanceTypes: [instanceType],
            ProductDescriptions: ["Linux/UNIX"],
            StartTime: oneDayAgo,
        }),
    );

    let averagePrice: number;
    try {
        averagePrice = averageUsableSpotPrice(response.SpotPriceHistory ?? []);
    } catch {
        throw new Error(`No spot price history found for ${instanceType} in a usable AZ of ${region}`);
    }

    logger.info("Fetched AWS spot price", { extra: { instanceType, region, averagePrice } });
    return averagePrice;
}

/**
 * Blends on-demand and spot derived rates by the real fraction of recent capacity that
 * actually landed on spot (see `fetchRecentBuildCapacityMix`), rather than assuming either
 * 100% on-demand (overstates cost) or 100% spot (understates it, and wrong whenever Karpenter
 * falls back to on-demand because spot capacity was unavailable).
 */
export function blendComputeResourceRates(
    onDemand: UsdComputeRates,
    spot: UsdComputeRates,
    spotFraction: number,
): UsdComputeRates {
    if (spotFraction < 0 || spotFraction > 1) {
        throw new Error(`spotFraction must be between 0 and 1, got ${spotFraction}`);
    }

    const onDemandFraction = 1 - spotFraction;
    return {
        usdPerVcpuHour: spotFraction * spot.usdPerVcpuHour + onDemandFraction * onDemand.usdPerVcpuHour,
        usdPerGbHour: spotFraction * spot.usdPerGbHour + onDemandFraction * onDemand.usdPerGbHour,
    };
}

/** Converts derived USD resource rates to credits, using the same `creditsPerUsd` exchange rate `credits.service.ts` uses elsewhere. */
export function toCreditRates(rates: UsdComputeRates, creditsPerUsd: number): ComputeResourceRates {
    return {
        creditsPerVcpuHour: rates.usdPerVcpuHour * creditsPerUsd,
        creditsPerGbMemoryHour: rates.usdPerGbHour * creditsPerUsd,
    };
}
