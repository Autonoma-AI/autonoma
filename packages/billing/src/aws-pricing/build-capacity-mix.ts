import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";

export interface BuildCapacityMix {
    spotFraction: number;
    sampleSize: number;
}

/**
 * The real spot-vs-on-demand mix Karpenter actually provisioned for buildkit builds since
 * `sinceDate`, from `PreviewkitAppBuildUsage.capacityType` (recorded by
 * `BuildKitJobManager.provision()` off the real node's labels). Used to weight the on-demand
 * and spot derived rates into a single blended rate that reflects what buildkit actually
 * pays, rather than assuming every build lands on whichever capacity type is cheapest.
 *
 * `spotFraction` is weighted by `vcpuSeconds`, not by build count: builds run for very different
 * durations, so weighting each row equally would let a 1-minute spot build and a 60-minute
 * on-demand build distort the mix to 50% spot instead of the ~1.6% (1/61) of actual compute-time
 * they represent. `gbSeconds` would weight the same way under today's fixed per-instance vcpu:GB
 * ratio; `vcpuSeconds` is used because `blendComputeResourceRates` blends both rates off this one
 * fraction. `sampleSize` stays a build count - it's only ever used to report how much data backed
 * the mix, not to weight it.
 *
 * Rows with no resolved `capacityType` (a best-effort node lookup that failed) are excluded
 * rather than guessed at. Returns undefined when there's no usable data in the window, so the
 * caller can fall back to a pure on-demand rate instead of dividing by zero.
 */
export async function fetchRecentBuildCapacityMix(
    db: PrismaClient,
    sinceDate: Date,
    logger: Logger,
): Promise<BuildCapacityMix | undefined> {
    const rows = await db.previewkitAppBuildUsage.groupBy({
        by: ["capacityType"],
        where: { capacityType: { not: null }, createdAt: { gte: sinceDate } },
        _count: { _all: true },
        _sum: { vcpuSeconds: true },
    });

    const sampleSize = rows.reduce((sum, row) => sum + row._count._all, 0);
    const totalVcpuSeconds = rows.reduce((sum, row) => sum + (row._sum.vcpuSeconds ?? 0), 0);
    if (sampleSize === 0 || totalVcpuSeconds === 0) {
        logger.warn("No build capacity-type data available to compute a spot/on-demand mix", {
            extra: { sinceDate, sampleSize, totalVcpuSeconds },
        });
        return undefined;
    }

    const spotVcpuSeconds = rows.find((row) => row.capacityType === "spot")?._sum.vcpuSeconds ?? 0;
    const mix = { spotFraction: spotVcpuSeconds / totalVcpuSeconds, sampleSize };
    logger.info("Computed recent build capacity mix", { extra: { sinceDate, ...mix, totalVcpuSeconds } });
    return mix;
}
