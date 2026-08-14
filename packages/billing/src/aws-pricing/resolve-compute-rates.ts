import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import {
    AWS_EC2_REGION_US_EAST_1,
    AWS_PRICING_LOCATION_US_EAST_1,
    blendComputeResourceRates,
    type ComputePoolReference,
    deriveComputeResourceRates,
    fetchOnDemandInstancePrice,
    fetchSpotPrice,
    type OnDemandInstancePrice,
    type UsdComputeRates,
} from "./aws-instance-pricing";
import { type BuildCapacityMix, fetchRecentBuildCapacityMix } from "./build-capacity-mix";

const CAPACITY_MIX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface ResolvedComputeRates {
    onDemand: { lighter: OnDemandInstancePrice; heavier: OnDemandInstancePrice; rates: UsdComputeRates };
    spot?: { rates: UsdComputeRates; capacityMix: BuildCapacityMix };
    /** The rate to actually use: spot-blended when the pool supports spot and recent build data
     *  exists to weight it, the plain on-demand rate otherwise. */
    rates: UsdComputeRates;
}

/**
 * Resolves a compute pool's real, current $/vCPU-hr and $/GB-hr rate - on-demand only for an
 * on-demand-only pool (previewkit), or blended by the real spot/on-demand mix buildkit
 * actually got over the last 14 days for a spot-eligible pool (buildkit). Shared by the manual
 * CLI (`derive-compute-pricing-cli.ts`) and the scheduled drift check
 * (`apps/cronjobs/scripts/aws-compute-pricing-drift`) so both always compute the identical
 * number - a "why did the CLI print a different rate than the alert" split would defeat the
 * point of either one.
 */
export async function resolveComputeRates(
    pool: ComputePoolReference,
    db: PrismaClient,
    logger: Logger,
): Promise<ResolvedComputeRates> {
    const [lighter, heavier] = await Promise.all([
        fetchOnDemandInstancePrice(pool.lighterInstanceType, AWS_PRICING_LOCATION_US_EAST_1, logger),
        fetchOnDemandInstancePrice(pool.heavierInstanceType, AWS_PRICING_LOCATION_US_EAST_1, logger),
    ]);
    const onDemandRates = deriveComputeResourceRates(lighter, heavier);
    const onDemand = { lighter, heavier, rates: onDemandRates };

    if (!pool.supportsSpot) {
        return { onDemand, rates: onDemandRates };
    }

    const sinceDate = new Date(Date.now() - CAPACITY_MIX_WINDOW_MS);
    const [spotLighterPrice, spotHeavierPrice, capacityMix] = await Promise.all([
        fetchSpotPrice(pool.lighterInstanceType, AWS_EC2_REGION_US_EAST_1, logger),
        fetchSpotPrice(pool.heavierInstanceType, AWS_EC2_REGION_US_EAST_1, logger),
        fetchRecentBuildCapacityMix(db, sinceDate, logger),
    ]);
    if (capacityMix == null) {
        return { onDemand, rates: onDemandRates };
    }

    const spotRates = deriveComputeResourceRates(
        { ...lighter, usdPerHour: spotLighterPrice },
        { ...heavier, usdPerHour: spotHeavierPrice },
    );
    const blendedRates = blendComputeResourceRates(onDemandRates, spotRates, capacityMix.spotFraction);
    return { onDemand, spot: { rates: spotRates, capacityMix }, rates: blendedRates };
}
