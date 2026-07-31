import { db, VercelBillingPeriodStatus, VercelInstallationStatus } from "@autonoma/db";
import type { Prisma, VercelBillingPlan } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { EncryptionHelper } from "@autonoma/utils";
import { captureCheckIn } from "@sentry/node";
import { z } from "zod";
import { env } from "../vercel-env";

const logger = rootLogger.child({ name: "VercelBillingInvoicer" });
const encryptionHelper = new EncryptionHelper(env.VERCEL_ENCRYPTION_KEY);

const JOB_NAME = "vercel-billing-invoicer";
const VERCEL_BILLING_API = "https://api.vercel.com/v1";

async function main() {
    const mainCheckInId = captureCheckIn({
        monitorSlug: JOB_NAME,
        status: "in_progress",
    });

    try {
        await createInvoices();
        captureCheckIn({
            checkInId: mainCheckInId,
            monitorSlug: JOB_NAME,
            status: "ok",
        });
    } catch (error) {
        logger.error("Error while running billing-invoicer", { error });
        captureCheckIn({
            checkInId: mainCheckInId,
            monitorSlug: JOB_NAME,
            status: "error",
        });
        throw error;
    }
}

async function createInvoices() {
    logger.info("Starting invoice submission", { timestamp: new Date().toISOString() });

    const now = new Date();
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const endOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

    logger.info("Querying billing periods", { startOfToday, endOfToday });

    // Two independent triggers feed the same invoicing path below:
    // - `pending` periods are the one-time seed for legacy-migrated installations
    //   whose first cycle hasn't been billed by us yet (see navigator-vercel-migration).
    //   They never accrue usage while pending, so their overage is always zero -
    //   this branch only ever bills the flat plan fee.
    // - `active` periods whose cycle ends today are every ongoing renewal (fresh
    //   signups and migrated installations alike, from their second cycle on) -
    //   the only branch that can carry real accrued overage, since usage only
    //   ever accrues onto the currently-active period.
    const periodInclude = {
        installation: { include: { billingPlan: true } },
        plan: true,
    } as const;

    const [pendingPeriods, endingActivePeriods] = await Promise.all([
        db.vercelBillingPeriod.findMany({
            where: {
                startDate: { gte: startOfToday, lte: endOfToday },
                status: VercelBillingPeriodStatus.pending,
                invoices: { none: {} },
            },
            include: periodInclude,
        }),
        db.vercelBillingPeriod.findMany({
            where: {
                endDate: { gte: startOfToday, lte: endOfToday },
                status: VercelBillingPeriodStatus.active,
                invoices: { none: {} },
            },
            include: periodInclude,
        }),
    ]);

    const periodsToInvoice = [...pendingPeriods, ...endingActivePeriods];

    logger.info("Found billing periods to invoice", {
        pendingCount: pendingPeriods.length,
        endingActiveCount: endingActivePeriods.length,
    });

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const period of periodsToInvoice) {
        try {
            if (period.installation?.status !== VercelInstallationStatus.active) {
                logger.info("Skipping period - installation not active", { periodId: period.id });
                skipped++;
                continue;
            }

            const plan: VercelBillingPlan = period.installation.billingPlan ?? period.plan;
            if (plan == null || !plan.paymentMethodRequired) {
                logger.info("Skipping period - free plan", { periodId: period.id });
                skipped++;
                continue;
            }

            const initialCharge = plan.initialCharge;
            if (initialCharge == null) {
                logger.info("Skipping period - no initial charge", { periodId: period.id });
                skipped++;
                continue;
            }

            const overage = computeOverageCharge(period.overageCreditsGranted, plan.overagePricePerCredit);

            const accessTokenEnc = period.installation.accessTokenEnc;
            if (accessTokenEnc == null) {
                logger.warn("Skipping period - no access token", { periodId: period.id });
                skipped++;
                continue;
            }
            const accessToken = encryptionHelper.decrypt(accessTokenEnc);

            const resourceId = period.resourceId;
            if (resourceId == null) {
                logger.warn("Skipping period - no resource ID", { periodId: period.id });
                skipped++;
                continue;
            }

            const result = await submitInvoiceToVercel({
                vercelInstallationId: period.installation.vercelInstallationId,
                accessToken,
                billingPeriodId: period.id,
                installationId: period.installation.id,
                wasPending: period.status === VercelBillingPeriodStatus.pending,
                period: {
                    start: period.startDate,
                    end: period.endDate,
                },
                planId: plan.id,
                planName: plan.name,
                planDescription: plan.description,
                amount: initialCharge,
                resourceId,
                overage,
            });

            if (result) {
                success++;
            } else {
                failed++;
            }
        } catch (error) {
            logger.error("Error processing period", { periodId: period.id, error });
            failed++;
        }
    }

    logger.info("Invoice submission complete", { success, failed, skipped });
}

type OverageCharge = {
    creditsGranted: number;
    /** Per-1,000-credit rate, formatted to Vercel's required 2 decimal places. */
    pricePerThousandCredits: string;
    /** Fractional units of 1,000 credits - Vercel's own examples use fractional quantities (e.g. `4.2` GB). */
    quantityThousandCredits: number;
    amount: string;
};

/**
 * Vercel requires the `price`/`total` fields on an invoice item to be decimal
 * strings with exactly 2 fractional digits, but our per-credit overage rate is
 * sub-cent (e.g. $0.0007). Billing by "1,000 credits" instead of "1 credit"
 * keeps the displayed unit price meaningful at 2 decimals while `total` still
 * reflects the precise amount owed. `undefined` means this plan has no
 * pay-per-usage overage, or nothing was granted this period.
 */
function computeOverageCharge(
    creditsGranted: number,
    pricePerCredit: Prisma.Decimal | null,
): OverageCharge | undefined {
    if (pricePerCredit == null || creditsGranted <= 0) return undefined;

    const rate = parseFloat(pricePerCredit.toString());
    return {
        creditsGranted,
        pricePerThousandCredits: (rate * 1000).toFixed(2),
        quantityThousandCredits: creditsGranted / 1000,
        amount: (creditsGranted * rate).toFixed(2),
    };
}

async function submitInvoiceToVercel(params: {
    vercelInstallationId: string;
    accessToken: string;
    billingPeriodId: string;
    installationId: string;
    /** True for the one-time legacy-migration seed; false for every ongoing renewal. */
    wasPending: boolean;
    period: { start: Date; end: Date };
    planId: string;
    planName: string;
    planDescription: string;
    amount: string;
    resourceId: string;
    overage?: OverageCharge;
}): Promise<boolean> {
    const url = `${VERCEL_BILLING_API}/installations/${params.vercelInstallationId}/billing/invoices`;

    const periodStartIso = params.period.start.toISOString();
    const periodEndIso = params.period.end.toISOString();

    const items = [
        {
            resourceId: params.resourceId,
            billingPlanId: params.planId,
            start: periodStartIso,
            end: periodEndIso,
            name: params.planName,
            details: params.planDescription,
            price: params.amount,
            quantity: 1,
            units: "subscription",
            total: params.amount,
        },
    ];

    if (params.overage != null) {
        items.push({
            resourceId: params.resourceId,
            billingPlanId: params.planId,
            start: periodStartIso,
            end: periodEndIso,
            name: "Additional credits",
            details: `${params.overage.creditsGranted.toLocaleString()} credits over the plan's included allotment`,
            price: params.overage.pricePerThousandCredits,
            quantity: params.overage.quantityThousandCredits,
            units: "1,000 credits",
            total: params.overage.amount,
        });
    }

    const totalAmount = (
        parseFloat(params.amount) + (params.overage != null ? parseFloat(params.overage.amount) : 0)
    ).toFixed(2);

    const payload = {
        invoiceDate: new Date().toISOString(),
        memo: `${params.planName} subscription - Billing period ${periodStartIso.split("T")[0]} to ${periodEndIso.split("T")[0]}`,
        period: {
            start: periodStartIso,
            end: periodEndIso,
        },
        items,
    };

    logger.info("Submitting invoice to Vercel", {
        installationId: params.vercelInstallationId,
        amount: totalAmount,
        overageAmount: params.overage?.amount,
        planName: params.planName,
    });

    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${params.accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        logger.error("Network error submitting invoice to Vercel", { url, error });
        return false;
    }

    if (!res.ok) {
        const errorText = await res.text();
        logger.error("Vercel invoice API error", { status: res.status, text: errorText });
        return false;
    }

    const responseData = z.object({ invoiceId: z.string() }).safeParse(await res.json());

    if (!responseData.success) {
        logger.error("Invalid response from Vercel invoice API", { url, error: responseData.error });
        return false;
    }

    logger.info("Vercel invoice API success", { invoiceId: responseData.data.invoiceId });
    const vercelInvoiceId = responseData.data.invoiceId;

    // Both writes below must land with the invoice: an invoiced period stuck in
    // its pre-invoice status, or an ended cycle with no successor period ever
    // created, both leave the billing state machine stuck for this installation
    // with no automatic way to recover.
    await db.$transaction(async (tx) => {
        await tx.vercelInvoice.create({
            data: {
                vercelInvoiceId,
                billingPeriodId: params.billingPeriodId,
                installationId: params.installationId,
                amount: totalAmount,
                status: "pending",
            },
        });

        if (params.wasPending) {
            // First cycle for a legacy-migrated installation - just activate it.
            // Its own renewal is picked up later by the active/endDate query once
            // this cycle's endDate arrives, same as every other installation.
            await tx.vercelBillingPeriod.update({
                where: { id: params.billingPeriodId },
                data: { status: VercelBillingPeriodStatus.active },
            });
            return;
        }

        // An ongoing cycle just ended - close it out and roll straight into the next one.
        await tx.vercelBillingPeriod.update({
            where: { id: params.billingPeriodId },
            data: { status: VercelBillingPeriodStatus.completed },
        });

        await createNextBillingPeriod(
            tx,
            params.billingPeriodId,
            params.installationId,
            params.planId,
            params.resourceId,
        );
    });

    return true;
}

async function createNextBillingPeriod(
    tx: Prisma.TransactionClient,
    currentPeriodId: string,
    installationId: string,
    planId: string,
    resourceId: string,
) {
    const currentPeriod = await tx.vercelBillingPeriod.findUnique({
        where: { id: currentPeriodId },
        include: { plan: true },
    });

    if (currentPeriod == null) {
        throw new Error(`Current billing period ${currentPeriodId} not found while creating next period`);
    }

    const plan = currentPeriod.plan;

    const nextStartDate = new Date(currentPeriod.endDate);
    const nextEndDate = new Date(nextStartDate);
    nextEndDate.setDate(nextEndDate.getDate() + plan.billingCycleDays);

    const nextPeriod = await tx.vercelBillingPeriod.create({
        data: {
            installationId,
            resourceId,
            planId,
            cycleNumber: currentPeriod.cycleNumber + 1,
            startDate: nextStartDate,
            endDate: nextEndDate,
            status: VercelBillingPeriodStatus.active,
        },
    });

    logger.info("Created next billing period", {
        installationId,
        planId,
        resourceId,
        cycleNumber: nextPeriod.cycleNumber,
        startDate: nextPeriod.startDate,
        endDate: nextPeriod.endDate,
    });
}

main()
    .then(async () => {
        await db.$disconnect();
        process.exit(0);
    })
    .catch(async (error) => {
        logger.error("Fatal error in main", { error });
        await db.$disconnect();
        process.exit(1);
    });
