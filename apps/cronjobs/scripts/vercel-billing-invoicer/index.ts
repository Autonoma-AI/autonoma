import { db, VercelBillingPeriodStatus, VercelInstallationStatus } from "@autonoma/db";
import type { Prisma, VercelBillingPlan } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { EncryptionHelper } from "@autonoma/utils";
import { captureCheckIn } from "@sentry/node";
import { z } from "zod";
import { env } from "../env";

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

    const periodsToInvoice = await db.vercelBillingPeriod.findMany({
        where: {
            startDate: {
                gte: startOfToday,
                lte: endOfToday,
            },
            status: VercelBillingPeriodStatus.pending,
            invoices: {
                none: {},
            },
        },
        include: {
            installation: {
                include: {
                    billingPlan: true,
                },
            },
            plan: true,
        },
    });

    logger.info("Found billing periods to invoice", { count: periodsToInvoice.length });

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
                period: {
                    start: period.startDate,
                    end: period.endDate,
                },
                planId: plan.id,
                planName: plan.name,
                planDescription: plan.description,
                amount: initialCharge,
                resourceId,
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

async function submitInvoiceToVercel(params: {
    vercelInstallationId: string;
    accessToken: string;
    billingPeriodId: string;
    installationId: string;
    period: { start: Date; end: Date };
    planId: string;
    planName: string;
    planDescription: string;
    amount: string;
    resourceId: string;
}): Promise<boolean> {
    const url = `${VERCEL_BILLING_API}/installations/${params.vercelInstallationId}/billing/invoices`;

    const payload = {
        invoiceDate: new Date().toISOString(),
        memo: `${params.planName} subscription - Billing period ${params.period.start.toISOString().split("T")[0]} to ${params.period.end.toISOString().split("T")[0]}`,
        period: {
            start: params.period.start.toISOString(),
            end: params.period.end.toISOString(),
        },
        items: [
            {
                resourceId: params.resourceId,
                billingPlanId: params.planId,
                start: params.period.start.toISOString(),
                end: params.period.end.toISOString(),
                name: params.planName,
                details: params.planDescription,
                price: params.amount,
                quantity: 1,
                units: "subscription",
                total: params.amount,
            },
        ],
    };

    logger.info("Submitting invoice to Vercel", {
        installationId: params.vercelInstallationId,
        amount: params.amount,
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

    // These four writes must land together: an invoice with no active period,
    // or an active period with no successor pending period, both leave the
    // billing state machine stuck for this installation with no automatic way
    // to recover. Previously each step ran independently and the last two
    // swallowed their own errors internally, so a failure partway through
    // silently completed the sequence anyway (i.e. an invoice charged with no
    // next billing period ever created).
    await db.$transaction(async (tx) => {
        await tx.vercelInvoice.create({
            data: {
                vercelInvoiceId,
                billingPeriodId: params.billingPeriodId,
                installationId: params.installationId,
                amount: params.amount,
                status: "pending",
            },
        });

        await tx.vercelBillingPeriod.update({
            where: { id: params.billingPeriodId },
            data: { status: VercelBillingPeriodStatus.active },
        });

        await createNextBillingPeriod(
            tx,
            params.billingPeriodId,
            params.installationId,
            params.planId,
            params.resourceId,
        );

        await markPreviousPeriodAsCompleted(
            tx,
            params.billingPeriodId,
            params.installationId,
            params.resourceId,
            params.planId,
        );
    });

    return true;
}

/**
 * Both this and {@link createNextBillingPeriod} run inside the caller's
 * `$transaction` and intentionally let errors propagate - swallowing them
 * here would let the transaction commit the invoice/active-period writes
 * while silently skipping the rest of the state machine.
 */
async function markPreviousPeriodAsCompleted(
    tx: Prisma.TransactionClient,
    currentPeriodId: string,
    installationId: string,
    resourceId: string,
    planId: string,
) {
    const currentPeriod = await tx.vercelBillingPeriod.findUnique({
        where: { id: currentPeriodId },
        select: { cycleNumber: true },
    });

    if (currentPeriod == null || currentPeriod.cycleNumber <= 1) {
        logger.info("No previous period exists, skipping");
        return;
    }

    const previousPeriod = await tx.vercelBillingPeriod.findFirst({
        where: {
            installationId,
            resourceId,
            planId,
            cycleNumber: currentPeriod.cycleNumber - 1,
            status: VercelBillingPeriodStatus.active,
        },
    });

    if (previousPeriod != null) {
        await tx.vercelBillingPeriod.update({
            where: { id: previousPeriod.id },
            data: { status: VercelBillingPeriodStatus.completed },
        });
        logger.info("Marked previous period as completed", {
            previousPeriodId: previousPeriod.id,
            cycleNumber: previousPeriod.cycleNumber,
        });
    }
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
            status: VercelBillingPeriodStatus.pending,
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
