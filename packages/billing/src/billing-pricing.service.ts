import type { PrismaClient } from "@autonoma/db";
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
            },
        });
    }
}
