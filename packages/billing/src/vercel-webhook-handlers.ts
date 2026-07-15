import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { BillingPricingService } from "./billing-pricing.service";
import { createBillingService } from "./billing.service";
import { env } from "./env";

export async function syncVercelPlanPricing(organizationId: string, creditsPerCycle: number): Promise<void> {
    const pricingService = new BillingPricingService(db);
    await pricingService.updateCreditsPerSubscription(organizationId, creditsPerCycle);
}

export async function processVercelInvoicePaid(installationId: string, invoiceId: string): Promise<void> {
    logger.info("Processing Vercel invoice paid", { installationId, invoiceId });

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
        select: { organizationId: true },
    });

    if (installation == null) {
        logger.warn("Vercel invoice paid: installation not found", { installationId });
        return;
    }

    await db.vercelInvoice.updateMany({
        where: { vercelInvoiceId: invoiceId },
        data: { status: "paid", paidAt: new Date() },
    });

    const billingService = createBillingService(db);
    await billingService.grantSubscriptionCredits(installation.organizationId, invoiceId);

    logger.info("Credits granted for Vercel invoice payment", {
        installationId,
        organizationId: installation.organizationId,
        invoiceId,
    });
}

/**
 * A refund means the invoice WAS paid and the money was later returned - it is
 * not a payment failure, so it must never route through
 * {@link processVercelInvoiceNotPaid} (that starts a grace period toward
 * suspension, which would unfairly punish a customer over e.g. a support-issued
 * partial refund or proration adjustment). This only updates our own invoice
 * record; it intentionally does not touch subscription/grace-period state.
 */
export async function processVercelInvoiceRefunded(installationId: string, invoiceId: string): Promise<void> {
    logger.info("Processing Vercel invoice refunded", { installationId, invoiceId });

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
        select: { organizationId: true },
    });

    if (installation == null) {
        logger.warn("Vercel invoice refunded: installation not found", { installationId });
        return;
    }

    await db.vercelInvoice.updateMany({
        where: { vercelInvoiceId: invoiceId },
        data: { status: "refunded" },
    });

    logger.info("Vercel invoice marked refunded", {
        installationId,
        organizationId: installation.organizationId,
        invoiceId,
    });
}

export async function processVercelInvoiceNotPaid(installationId: string): Promise<void> {
    logger.info("Processing Vercel invoice not paid / refunded", { installationId });

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
        select: { organizationId: true },
    });

    if (installation == null) {
        logger.warn("Vercel invoice not paid: installation not found", { installationId });
        return;
    }

    const billingService = createBillingService(db);
    await billingService.startGracePeriodByOrganizationId(installation.organizationId, env.BILLING_GRACE_PERIOD_DAYS);

    logger.info("Grace period started for Vercel invoice not paid", {
        installationId,
        organizationId: installation.organizationId,
        gracePeriodDays: env.BILLING_GRACE_PERIOD_DAYS,
    });
}
