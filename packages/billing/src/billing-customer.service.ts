import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { BILLING_CHECKOUT_TYPES, BILLING_PAYMENT_INTENT_TYPES, type BillingCheckoutType } from "@autonoma/types";
import { ensureBillingProvisioning } from "./billing-provisioning";
import { buildCustomerCreateIdempotencyKey, isUniqueConstraintError } from "./billing-utils";
import { env } from "./env";
import { Service } from "./service";
import { getStripe } from "./stripe-client";
import { syncStripeDataToDb } from "./stripe-sync";

export class BillingCustomerService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async getOrCreateCustomer(organizationId: string, orgName: string) {
        const existing = await ensureBillingProvisioning(this.db, organizationId);
        if (existing.stripeCustomerId != null) return existing;

        const stripe = getStripe();
        const stripeCustomer = await stripe.customers.create(
            {
                name: orgName,
                metadata: { organizationId },
            },
            {
                idempotencyKey: buildCustomerCreateIdempotencyKey(organizationId),
            },
        );

        try {
            const customer = await this.db.billingCustomer.update({
                where: { organizationId },
                data: { stripeCustomerId: stripeCustomer.id },
            });

            this.logger.info("Created Stripe customer", { organizationId, stripeCustomerId: stripeCustomer.id });
            return customer;
        } catch (error) {
            if (isUniqueConstraintError(error)) {
                const customer = await this.db.billingCustomer.findUnique({
                    where: { organizationId },
                });
                if (customer != null) return customer;
            }

            throw error;
        }
    }

    async createCheckoutSession(organizationId: string, type: BillingCheckoutType) {
        const org = await this.db.organization.findUnique({
            where: { id: organizationId },
            select: { name: true },
        });
        if (org == null) throw new NotFoundError("Organization not found");

        const customer = await this.getOrCreateCustomer(organizationId, org.name ?? organizationId);
        if (customer.stripeCustomerId == null) {
            throw new Error(`Stripe customer missing for organization ${organizationId}`);
        }
        const stripe = getStripe();
        const appUrl = env.APP_URL;

        if (type === BILLING_CHECKOUT_TYPES.SUBSCRIPTION) {
            if (env.STRIPE_SUBSCRIPTION_PRICE_ID == null) {
                throw new Error("STRIPE_SUBSCRIPTION_PRICE_ID is not configured");
            }

            const session = await stripe.checkout.sessions.create({
                mode: "subscription",
                customer: customer.stripeCustomerId,
                line_items: [{ price: env.STRIPE_SUBSCRIPTION_PRICE_ID, quantity: 1 }],
                payment_method_collection: "always",
                success_url: `${appUrl}/billing?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${appUrl}/billing`,
            });

            this.logger.info("Created subscription checkout session", { organizationId, sessionId: session.id });
            return { url: session.url };
        }

        if (env.STRIPE_TOPUP_PRICE_ID == null) {
            throw new Error("STRIPE_TOPUP_PRICE_ID is not configured");
        }

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            customer: customer.stripeCustomerId,
            line_items: [{ price: env.STRIPE_TOPUP_PRICE_ID, quantity: 1 }],
            payment_intent_data: {
                setup_future_usage: "off_session",
                metadata: { type: BILLING_PAYMENT_INTENT_TYPES.TOPUP, organizationId },
            },
            success_url: `${appUrl}/billing?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl}/billing`,
        });

        this.logger.info("Created topup checkout session", { organizationId, sessionId: session.id });
        return { url: session.url };
    }

    async createPortalSession(organizationId: string) {
        const org = await this.db.organization.findUnique({
            where: { id: organizationId },
            select: { name: true },
        });
        if (org == null) throw new NotFoundError("Organization not found");

        const customer = await this.getOrCreateCustomer(organizationId, org.name ?? organizationId);
        if (customer.stripeCustomerId == null) {
            throw new Error(`Stripe customer missing for organization ${organizationId}`);
        }

        const stripe = getStripe();
        const session = await stripe.billingPortal.sessions.create({
            customer: customer.stripeCustomerId,
            return_url: `${env.APP_URL}/billing`,
        });

        this.logger.info("Created billing portal session", { organizationId });
        return { url: session.url };
    }

    async getBillingStatus(organizationId: string) {
        const customer = await this.db.billingCustomer.findUnique({
            where: { organizationId },
            select: {
                creditBalance: true,
                subscriptionCreditBalance: true,
                subscriptionStatus: true,
                currentPeriodEnd: true,
                cancelAtPeriodEnd: true,
                gracePeriodEndsAt: true,
                autoTopUpEnabled: true,
                autoTopUpThreshold: true,
                transactions: {
                    orderBy: { createdAt: "desc" },
                    take: 20,
                },
            },
        });

        if (customer == null) {
            return {
                creditBalance: 0,
                subscriptionCreditBalance: 0,
                topupCreditBalance: 0,
                subscriptionStatus: undefined,
                currentPeriodEnd: undefined,
                cancelAtPeriodEnd: false,
                gracePeriodEndsAt: undefined,
                autoTopUpEnabled: false,
                autoTopUpThreshold: 0,
                transactions: [],
            };
        }

        return {
            creditBalance: customer.creditBalance,
            subscriptionCreditBalance: customer.subscriptionCreditBalance,
            topupCreditBalance: Math.max(0, customer.creditBalance - customer.subscriptionCreditBalance),
            subscriptionStatus: customer.subscriptionStatus ?? undefined,
            currentPeriodEnd: customer.currentPeriodEnd ?? undefined,
            cancelAtPeriodEnd: customer.cancelAtPeriodEnd,
            gracePeriodEndsAt: customer.gracePeriodEndsAt ?? undefined,
            autoTopUpEnabled: customer.autoTopUpEnabled,
            autoTopUpThreshold: customer.autoTopUpThreshold,
            transactions: customer.transactions,
        };
    }

    async startGracePeriodByStripeCustomerId(stripeCustomerId: string, gracePeriodDays: number) {
        const graceEndsAt = new Date(Date.now() + gracePeriodDays * 24 * 60 * 60 * 1000);
        const result = await this.db.billingCustomer.updateMany({
            where: { stripeCustomerId },
            data: { gracePeriodEndsAt: graceEndsAt },
        });
        this.logger.info("Updated billing grace period", {
            stripeCustomerId,
            gracePeriodDays,
            graceEndsAt,
            updatedCustomers: result.count,
        });
    }

    async clearGracePeriodByStripeCustomerId(stripeCustomerId: string) {
        const result = await this.db.billingCustomer.updateMany({
            where: { stripeCustomerId },
            data: { gracePeriodEndsAt: null },
        });
        this.logger.info("Cleared billing grace period", { stripeCustomerId, updatedCustomers: result.count });
    }

    async updateAutoTopUp(organizationId: string, enabled: boolean, threshold: number) {
        const org = await this.db.organization.findUnique({
            where: { id: organizationId },
            select: { name: true },
        });
        if (org == null) throw new NotFoundError("Organization not found");

        await this.getOrCreateCustomer(organizationId, org.name ?? organizationId);

        await this.db.billingCustomer.update({
            where: { organizationId },
            data: { autoTopUpEnabled: enabled, autoTopUpThreshold: threshold },
        });

        this.logger.info("Updated auto top-up settings", { organizationId, enabled, threshold });
    }

    async syncFromStripe(stripeCustomerId: string) {
        await syncStripeDataToDb(stripeCustomerId, this.db);
    }

    async findCustomerByStripeId(stripeCustomerId: string) {
        return this.db.billingCustomer.findUnique({
            where: { stripeCustomerId },
        });
    }
}
