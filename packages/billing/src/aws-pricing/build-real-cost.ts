import type { Logger } from "@autonoma/logger";
import {
    AWS_EC2_REGION_US_EAST_1,
    AWS_PRICING_LOCATION_US_EAST_1,
    type Ec2InstanceType,
    fetchOnDemandInstancePrice,
    fetchSpotPrice,
} from "./aws-instance-pricing";

export type BuildCapacityType = "spot" | "on-demand";

/**
 * The real hourly USD price for the EXACT instance a build actually landed on - spot's current
 * price for a spot build (called right as the build finishes, so "current" is "at the time this
 * build ran"; spot prices drift over days, not minutes, so that's an accurate reconstruction, not
 * a stale one), or the stable on-demand price otherwise. Deliberately separate from
 * `resolveComputeRates`'s pool-level blended rate: that rate answers "what should we bill",
 * averaged across many builds against a fixed reference pair; this answers "what did THIS build
 * cost", for the one real instance Karpenter actually gave it.
 */
export async function fetchBuildInstanceHourlyPrice(
    instanceType: Ec2InstanceType,
    capacityType: BuildCapacityType,
    logger: Logger,
): Promise<number> {
    if (capacityType === "spot") return fetchSpotPrice(instanceType, AWS_EC2_REGION_US_EAST_1, logger);
    const onDemand = await fetchOnDemandInstancePrice(instanceType, AWS_PRICING_LOCATION_US_EAST_1, logger);
    return onDemand.usdPerHour;
}
