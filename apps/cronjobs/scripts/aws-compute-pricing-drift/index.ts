import { REFERENCE_COMPUTE_POOLS, syncComputePricingReference, type ComputePoolReference } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { type Logger, logger as rootLogger, runWithSentry } from "@autonoma/logger";
import { captureCheckIn } from "@sentry/node";
import "../env";

const JOB_NAME = "aws-compute-pricing-drift";

// Relative change from the previous stored reference that's worth a human's attention. AWS
// repricing an instance family is rare and usually small (a few percent); anything past this is
// either a real reprice worth reacting to, a meaningful shift in buildkit's spot/on-demand mix,
// or a sign the reference instance types need revisiting.
const DRIFT_ALERT_THRESHOLD = 0.1;

/**
 * Fetches each compute pool's current AWS-derived rate, upserts it into the global
 * `ComputePricingReference` table (see `syncComputePricingReference`), and pages (Sentry,
 * "warning") when it moved more than `DRIFT_ALERT_THRESHOLD` from what was stored last run.
 *
 * This never touches any org's live `BillingPricing` - the reference table it writes only ever
 * informs a later, deliberate `admin.billing.updateComputePricing` call. There's no hardcoded
 * baseline to maintain: each run compares against whatever the previous run stored, so the
 * comparison point is always current by construction.
 */
async function main() {
    const logger = rootLogger.child({ name: JOB_NAME });

    // The pools are fully independent - each fetches its own AWS pricing and upserts its own row
    // by primary key with no shared state - so they run concurrently rather than one after another.
    await Promise.all(REFERENCE_COMPUTE_POOLS.map((pool) => checkPoolDrift(pool, logger)));
}

async function checkPoolDrift(pool: ComputePoolReference, logger: Logger): Promise<void> {
    const { previous, current, resolved } = await syncComputePricingReference(pool, db, logger);

    if (previous == null) {
        logger.info("No previous compute pricing reference to compare against - stored the first one", {
            extra: { pool: pool.name, current },
        });
        return;
    }

    const vcpuRelativeChange = relativeChange(current.usdPerVcpuHour, previous.usdPerVcpuHour);
    const gbRelativeChange = relativeChange(current.usdPerGbHour, previous.usdPerGbHour);
    logger.info("Checked AWS compute pricing for drift", {
        extra: { pool: pool.name, source: pool.source, previous, current, vcpuRelativeChange, gbRelativeChange },
    });

    const vcpuDrifted = vcpuRelativeChange > DRIFT_ALERT_THRESHOLD;
    const gbDrifted = gbRelativeChange > DRIFT_ALERT_THRESHOLD;
    if (vcpuDrifted || gbDrifted) {
        logger.captureError(
            new Error(
                `AWS compute pricing for the "${pool.name}" pool drifted since the last check: ` +
                    `${describeDrift("vCPU-hr", vcpuDrifted, previous.usdPerVcpuHour, current.usdPerVcpuHour, vcpuRelativeChange)}` +
                    `${describeDrift("GB-hr", gbDrifted, previous.usdPerGbHour, current.usdPerGbHour, gbRelativeChange)}` +
                    `Review whether any org's BillingPricing needs an update via admin.billing.updateComputePricing.`,
            ),
            {
                pool: pool.name,
                previousUsdPerVcpuHour: previous.usdPerVcpuHour,
                currentUsdPerVcpuHour: current.usdPerVcpuHour,
                vcpuRelativeChange,
                previousUsdPerGbHour: previous.usdPerGbHour,
                currentUsdPerGbHour: current.usdPerGbHour,
                gbRelativeChange,
                spot: resolved.spot,
            },
            "warning",
        );
    }
}

function relativeChange(current: number, previous: number): number {
    return Math.abs(current - previous) / previous;
}

/** One drifted-rate clause for the alert message, or an empty string when that rate didn't drift. */
function describeDrift(label: string, drifted: boolean, previous: number, current: number, change: number): string {
    if (!drifted) return "";
    return `${label}: $${previous} -> $${current.toFixed(5)} (${(change * 100).toFixed(1)}%). `;
}

async function run() {
    const checkInId = captureCheckIn({ monitorSlug: JOB_NAME, status: "in_progress" });
    try {
        await main();
        captureCheckIn({ checkInId, monitorSlug: JOB_NAME, status: "ok" });
    } catch (error) {
        captureCheckIn({ checkInId, monitorSlug: JOB_NAME, status: "error" });
        throw error;
    }
}

runWithSentry({ name: JOB_NAME }, run);
