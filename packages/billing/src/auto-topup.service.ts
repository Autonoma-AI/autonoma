import type { PrismaClient } from "@autonoma/db";
import { BILLING_PAYMENT_INTENT_TYPES } from "@autonoma/types";
import type { BillingPricingValues } from "./billing-pricing.types";
import { buildAutoTopUpIdempotencyKey } from "./billing-utils";
import { Service } from "./service";
import { getStripe } from "./stripe-client";

export class AutoTopUpService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async triggerAutoTopUp(organizationId: string, pricing: BillingPricingValues) {
        const customer = await this.db.billingCustomer.findUnique({
            where: { organizationId },
        });

        if (customer == null) return;
        if (!customer.autoTopUpEnabled || customer.creditBalance >= customer.autoTopUpThreshold) return;
        if (customer.stripeCustomerId == null) {
            this.logger.warn("Auto top-up skipped: Stripe customer not linked yet", { organizationId });
            return;
        }

        this.logger.info("Triggering auto top-up", {
            organizationId,
            creditBalance: customer.creditBalance,
            threshold: customer.autoTopUpThreshold,
        });

        const stripe = getStripe();
        const paymentMethods = await stripe.customers.listPaymentMethods(customer.stripeCustomerId, { limit: 1 });
        const paymentMethod = paymentMethods.data[0];

        if (paymentMethod == null) {
            this.logger.warn("Auto top-up: no saved payment method found", { organizationId });
            return;
        }

        try {
            await stripe.paymentIntents.create(
                {
                    amount: pricing.stripeTopupAmountCents,
                    currency: "usd",
                    customer: customer.stripeCustomerId,
                    payment_method: paymentMethod.id,
                    confirm: true,
                    off_session: true,
                    metadata: { type: BILLING_PAYMENT_INTENT_TYPES.TOPUP, organizationId },
                },
                {
                    idempotencyKey: buildAutoTopUpIdempotencyKey(organizationId),
                },
            );

            this.logger.info("Auto top-up payment intent created", { organizationId });
        } catch (error) {
            this.logger.error("Auto top-up payment failed", error, {
                organizationId,
                stripeCustomerId: customer.stripeCustomerId,
                threshold: customer.autoTopUpThreshold,
                creditBalance: customer.creditBalance,
            });
        }
    }
}
