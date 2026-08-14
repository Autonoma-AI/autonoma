import type { ComputePricingReference, PrismaClient } from "@autonoma/db";
import type { BillingPricingValues } from "./billing-pricing.types";
import { Service } from "./service";

export class BillingPricingService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async getOrCreatePricing(organizationId: string): Promise<BillingPricingValues> {
        const existing = await this.db.billingPricing.findUnique({
            where: { organizationId },
            select: {
                creditsPerSubscription: true,
                creditsPerTopup: true,
                creditsFreeStart: true,
                creditsWebGenerationCost: true,
                creditsIosGenerationCost: true,
                creditsAndroidGenerationCost: true,
                creditsWebRunCost: true,
                creditsIosRunCost: true,
                creditsAndroidRunCost: true,
                stripeTopupAmountCents: true,
                creditsPerVcpuHour: true,
                creditsPerGbMemoryHour: true,
            },
        });
        if (existing != null) return existing;

        return this.db.billingPricing.upsert({
            where: { organizationId },
            create: { organizationId },
            update: {},
            select: {
                creditsPerSubscription: true,
                creditsPerTopup: true,
                creditsFreeStart: true,
                creditsWebGenerationCost: true,
                creditsIosGenerationCost: true,
                creditsAndroidGenerationCost: true,
                creditsWebRunCost: true,
                creditsIosRunCost: true,
                creditsAndroidRunCost: true,
                stripeTopupAmountCents: true,
                creditsPerVcpuHour: true,
                creditsPerGbMemoryHour: true,
            },
        });
    }

    async updateCreditsPerSubscription(organizationId: string, creditsPerSubscription: number): Promise<void> {
        await this.db.billingPricing.upsert({
            where: { organizationId },
            create: { organizationId, creditsPerSubscription },
            update: { creditsPerSubscription },
        });
        this.logger.info("Updated creditsPerSubscription for organization", { organizationId, creditsPerSubscription });
    }

    /**
     * Sets an org's live previewkit compute-usage rate - a deliberate, admin-triggered write,
     * never touched by the pricing-drift cronjob (which only writes the informational, global
     * `ComputePricingReference`). The column is `Int` (whole credits per hour), so a fractional
     * suggestion (e.g. from `ComputePricingReference` converted through this org's creditsPerUsd)
     * is rounded here rather than by the caller, so every write path rounds the same way.
     */
    async updateComputePricing(
        organizationId: string,
        rates: { creditsPerVcpuHour: number; creditsPerGbMemoryHour: number },
    ): Promise<void> {
        const creditsPerVcpuHour = Math.round(rates.creditsPerVcpuHour);
        const creditsPerGbMemoryHour = Math.round(rates.creditsPerGbMemoryHour);

        await this.db.billingPricing.upsert({
            where: { organizationId },
            create: { organizationId, creditsPerVcpuHour, creditsPerGbMemoryHour },
            update: { creditsPerVcpuHour, creditsPerGbMemoryHour },
        });
        this.logger.info("Updated compute pricing for organization", {
            organizationId,
            creditsPerVcpuHour,
            creditsPerGbMemoryHour,
        });
    }

    /**
     * The global (not org-scoped) AWS-derived reference rates the pricing-drift cronjob keeps
     * current - one row per compute pool. Purely informational: shown next to an org's live
     * rate in the admin Usage tab so an admin can decide whether to apply it via
     * `updateComputePricing`.
     */
    async getComputePricingReferences(): Promise<ComputePricingReference[]> {
        return this.db.computePricingReference.findMany({ orderBy: { pool: "asc" } });
    }
}
