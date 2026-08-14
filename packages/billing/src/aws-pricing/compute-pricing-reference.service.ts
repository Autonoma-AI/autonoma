import type { ComputePricingReference, PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import type { ComputePoolReference, UsdComputeRates } from "./aws-instance-pricing";
import { resolveComputeRates, type ResolvedComputeRates } from "./resolve-compute-rates";

export interface ComputePricingSyncResult {
    previous?: ComputePricingReference;
    resolved: ResolvedComputeRates;
    current: ComputePricingReference;
}

interface ComputePricingReferenceData {
    usdPerVcpuHour: number;
    usdPerGbHour: number;
    spotFraction: number | null;
    sampleSize: number | null;
}

/**
 * Builds the row data for a resolved rate. `spotFraction`/`sampleSize` are explicit `null` (not
 * `undefined`) when `resolved.spot` is absent - a fallback to on-demand-only (no recent capacity
 * mix to blend, or an on-demand-only pool) - because Prisma treats an `undefined` field in an
 * `update` as "leave the stored value untouched", not "clear it". Passing `undefined` here would
 * upsert fresh on-demand-only rates next to a stale spot fraction/sample size left over from the
 * last time this pool DID have a blended rate, misrepresenting a 100% on-demand rate as blended.
 */
export function toComputePricingReferenceData(resolved: ResolvedComputeRates): ComputePricingReferenceData {
    return {
        usdPerVcpuHour: resolved.rates.usdPerVcpuHour,
        usdPerGbHour: resolved.rates.usdPerGbHour,
        spotFraction: resolved.spot?.capacityMix.spotFraction ?? null,
        sampleSize: resolved.spot?.capacityMix.sampleSize ?? null,
    };
}

/**
 * Resolves a pool's current AWS-derived rate and upserts it into the global
 * `ComputePricingReference` row for that pool, returning the previous stored row alongside it so
 * the caller can compare and decide whether the change is worth a human's attention. Safe to
 * call on any schedule with no review step - this table only ever informs a later, deliberate
 * `admin.billing.updateComputePricing` call, never an org's live `BillingPricing` directly.
 */
export async function syncComputePricingReference(
    pool: ComputePoolReference,
    db: PrismaClient,
    logger: Logger,
): Promise<ComputePricingSyncResult> {
    const [previous, resolved] = await Promise.all([
        db.computePricingReference.findUnique({ where: { pool: pool.name } }),
        resolveComputeRates(pool, db, logger),
    ]);

    const data = toComputePricingReferenceData(resolved);
    const current = await db.computePricingReference.upsert({
        where: { pool: pool.name },
        create: { pool: pool.name, ...data },
        update: data,
    });

    logger.info("Synced compute pricing reference", {
        extra: { pool: pool.name, previousUsdPerVcpuHour: previous?.usdPerVcpuHour, current },
    });

    return { previous: previous ?? undefined, resolved, current };
}

/** Converts a stored global reference row to USD resource rates, for the admin "apply" flow. */
export function referenceToUsdRates(reference: ComputePricingReference): UsdComputeRates {
    return { usdPerVcpuHour: reference.usdPerVcpuHour, usdPerGbHour: reference.usdPerGbHour };
}
