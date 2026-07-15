import { createBillingService } from "@autonoma/billing";
import { db, VercelBillingPeriodStatus } from "@autonoma/db";
import type { VercelBillingPlan } from "@autonoma/db";
import { ThirdPartyError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";
import { getVercelEncryptionHelper } from "../context";

const logger = rootLogger.child({ name: "VercelBilling" });

const VERCEL_BILLING_API = "https://api.vercel.com/v1";

const VercelInvoiceResponseSchema = z.object({
    invoiceId: z.string(),
});

/**
 * Creates a new billing period for an installation or resource, rotating out
 * any previous periods. The DB-only steps (expire/cancel old periods, compute
 * the next cycle number, create the new period) run inside a single
 * transaction for consistency. The optional invoice submission to Vercel is
 * intentionally kept outside the transaction - it's an external network call,
 * and holding a DB transaction open across it risks long-lived locks if
 * Vercel is slow or unavailable.
 */
export async function createBillingPeriod(
    installationId: string,
    planId: string,
    resourceId?: string,
    invoiceImmediately?: boolean,
): Promise<void> {
    logger.info("Creating billing period", { installationId, planId, resourceId, invoiceImmediately });

    const plan = await db.vercelBillingPlan.findUnique({ where: { id: planId } });
    if (plan == null) {
        throw new Error(`Billing plan not found: ${planId}`);
    }

    const now = new Date();

    const period = await db.$transaction(async (tx) => {
        // Expire outdated periods
        const expireWhen =
            resourceId != null
                ? { resourceId, endDate: { lt: now }, status: { not: VercelBillingPeriodStatus.expired } }
                : { installationId, endDate: { lt: now }, status: { not: VercelBillingPeriodStatus.expired } };

        await tx.vercelBillingPeriod.updateMany({
            where: expireWhen,
            data: { status: VercelBillingPeriodStatus.expired },
        });

        // Cancel existing active periods
        const cancelWhere =
            resourceId != null
                ? { resourceId, status: VercelBillingPeriodStatus.active }
                : { installationId, status: VercelBillingPeriodStatus.active };

        await tx.vercelBillingPeriod.updateMany({
            where: cancelWhere,
            data: { status: VercelBillingPeriodStatus.cancelled, updatedAt: now },
        });

        // Find current cycle number
        const lastPeriodWhere = resourceId != null ? { resourceId } : { installationId };

        const lastPeriod = await tx.vercelBillingPeriod.findFirst({
            where: lastPeriodWhere,
            orderBy: { cycleNumber: "desc" },
        });

        const cycleNumber = lastPeriod != null ? lastPeriod.cycleNumber + 1 : 1;
        const endDate = new Date(now.getTime() + plan.billingCycleDays * 24 * 60 * 60 * 1000);

        return tx.vercelBillingPeriod.create({
            data: {
                installationId,
                resourceId,
                planId,
                cycleNumber,
                startDate: now,
                endDate,
                status: VercelBillingPeriodStatus.active,
            },
        });
    });

    logger.info("Billing period created", {
        periodId: period.id,
        cycleNumber: period.cycleNumber,
        endDate: period.endDate,
    });

    if (invoiceImmediately !== true) return;

    if (!plan.paymentMethodRequired) {
        // Free plans are never invoiced, so `processVercelInvoicePaid` (the only
        // other place credits get granted) never fires for them - grant the
        // plan's credits directly here instead of leaving the org at 0 forever.
        const freeInstallation = await db.vercelInstallation.findUnique({
            where: { id: installationId },
            select: { organizationId: true },
        });
        if (freeInstallation == null) {
            logger.warn("Installation not found, skipping free plan credit grant", { installationId });
            return;
        }

        logger.info("Free plan - granting credits directly instead of invoicing", {
            installationId,
            planName: plan.name,
        });
        await createBillingService(db).grantSubscriptionCredits(
            freeInstallation.organizationId,
            `free_plan_${period.id}`,
        );
        return;
    }

    const installation = await db.vercelInstallation.findUnique({
        where: { id: installationId },
        select: { accessTokenEnc: true },
    });

    if (installation?.accessTokenEnc == null) {
        logger.warn("No access token for installation, skipping invoice submission", { installationId });
        return;
    }

    const accessToken = getVercelEncryptionHelper().decrypt(installation.accessTokenEnc);

    await submitInvoiceToVercel(
        installationId,
        period.id,
        period.startDate,
        period.endDate,
        plan,
        accessToken,
        resourceId,
    );
}

export async function submitInvoiceToVercel(
    installationId: string,
    billingPeriodId: string,
    periodStart: Date,
    periodEnd: Date,
    plan: VercelBillingPlan,
    accessToken: string,
    resourceId?: string,
): Promise<void> {
    logger.info("Submitting invoice to Vercel", { installationId, billingPeriodId, planName: plan.name, resourceId });

    const installation = await db.vercelInstallation.findUnique({
        where: { id: installationId },
    });

    if (installation == null) {
        throw new Error(`Installation not found: ${installationId}`);
    }

    const payload = {
        invoiceDate: new Date().toISOString(),
        memo: `${plan.name} subscription - Billing period ${periodStart.toISOString().split("T")[0]} to ${periodEnd.toISOString().split("T")[0]}`,
        period: {
            start: periodStart.toISOString(),
            end: periodEnd.toISOString(),
        },
        items: [
            {
                resourceId,
                billingPlanId: plan.id,
                start: periodStart.toISOString(),
                end: periodEnd.toISOString(),
                name: plan.name,
                details: plan.description,
                price: plan.cost,
                quantity: 1,
                units: "subscription",
                total: plan.cost,
            },
        ],
    };

    logger.info("Invoice payload", { installationId, payload });

    let res: Response;
    try {
        res = await fetch(`${VERCEL_BILLING_API}/installations/${installation.vercelInstallationId}/billing/invoices`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        logger.error("Network error submitting invoice to Vercel", { installationId, billingPeriodId, error });
        throw new ThirdPartyError("vercel", error, "Network error submitting invoice to Vercel");
    }

    const responseText = await res.text();

    if (!res.ok) {
        logger.error("Vercel invoice submission failed", {
            installationId,
            billingPeriodId,
            status: res.status,
            responseBody: responseText,
            payload,
        });
        throw new ThirdPartyError(
            "vercel",
            new Error(`${res.status} ${responseText}`),
            `Vercel invoice submission failed: ${res.status} ${responseText}`,
        );
    }

    logger.info("Vercel invoice submission response", {
        installationId,
        billingPeriodId,
        responseBody: responseText,
    });

    const response = VercelInvoiceResponseSchema.parse(JSON.parse(responseText));
    const vercelInvoiceId = response.invoiceId;

    await db.vercelInvoice.create({
        data: {
            vercelInvoiceId,
            billingPeriodId,
            installationId,
            amount: plan.cost,
            status: "pending",
        },
    });

    logger.info("Invoice recorded", { vercelInvoiceId, installationId, status: "pending" });
}
