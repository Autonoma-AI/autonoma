import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { REFERENCE_COMPUTE_POOLS, toCreditRates } from "./aws-instance-pricing";
import { resolveComputeRates } from "./resolve-compute-rates";

/**
 * Prints suggested `creditsPerVcpuHour`/`creditsPerGbMemoryHour` rates derived from live AWS
 * pricing, for a human to review before applying to `BillingPricing` - this never writes to
 * the database itself. Run with `tsx src/aws-pricing/derive-compute-pricing-cli.ts
 * [creditsPerUsd]`; omit `creditsPerUsd` to see only the raw USD rates.
 *
 * For a spot-eligible pool (currently just buildkit - see `ComputePoolReference.supportsSpot`),
 * the printed rate is blended by the real spot/on-demand mix buildkit actually got over the
 * last 14 days (see `resolveComputeRates`), not a pure on-demand assumption - on-demand alone
 * systematically overstates real cost whenever spot capacity was available.
 *
 * Caveats worth reading before applying a suggested rate:
 * - Previewkit's rate prices the deployed preview app pods (amd64, no dedicated Karpenter pool
 *   or fixed instance shape - see `REFERENCE_COMPUTE_POOLS`), so it's representative of one
 *   reference instance, not an exact average of everything the cluster might actually schedule.
 * - `BillingPricing` has one shared rate pair per org, used for both build and running usage,
 *   even though buildkit and previewkit are priced from different reference instances and
 *   buildkit's is spot-blended - picking one rate for both is an approximation either way.
 */
async function main() {
    const logger = rootLogger.child({ name: "derive-compute-pricing-cli" });
    const creditsPerUsdArg = process.argv[2];
    const creditsPerUsd = creditsPerUsdArg != null ? Number(creditsPerUsdArg) : undefined;

    for (const pool of REFERENCE_COMPUTE_POOLS) {
        const resolved = await resolveComputeRates(pool, db, logger);
        const creditRates = creditsPerUsd != null ? toCreditRates(resolved.rates, creditsPerUsd) : undefined;

        logger.info("Derived suggested compute pricing", {
            extra: {
                pool: pool.name,
                source: pool.source,
                onDemand: resolved.onDemand,
                spot: resolved.spot,
                usdRates: resolved.rates,
                creditsPerUsd,
                creditRates,
            },
        });
    }
}

main()
    .then(() => db.$disconnect())
    .catch((err: unknown) => {
        console.error("Failed to derive AWS compute pricing:", err);
        process.exit(1);
    });
