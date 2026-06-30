import type { PrismaClient } from "@autonoma/db";
import { CreditTransactionType } from "@autonoma/db";
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

    private buildAbsoluteAppUrl(pathWithQuery: string): string {
        return new URL(pathWithQuery, env.APP_URL).toString();
    }

    private buildCheckoutSuccessUrl(pathWithQuery: string): string {
        const url = new URL(pathWithQuery, env.APP_URL);
        url.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
        return url.toString();
    }

    private resolveCheckoutReturnPaths(returnPath?: string): { cancelPath: string; successPath: string } {
        const fallbackPath = "/billing";
        if (returnPath == null || returnPath.trim().length === 0) {
            return { cancelPath: fallbackPath, successPath: fallbackPath };
        }

        const normalizedPath = returnPath.trim();
        if (!normalizedPath.startsWith("/") || normalizedPath.startsWith("//")) {
            return { cancelPath: fallbackPath, successPath: fallbackPath };
        }

        const appBranchMatch = normalizedPath.match(/^\/app\/([^/]+)\//);
        if (appBranchMatch != null) {
            return {
                cancelPath: normalizedPath,
                successPath: `/app/${appBranchMatch[1]}/billing`,
            };
        }

        if (normalizedPath.startsWith("/billing")) {
            return { cancelPath: normalizedPath, successPath: fallbackPath };
        }

        return { cancelPath: normalizedPath, successPath: fallbackPath };
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

    async createCheckoutSession(organizationId: string, type: BillingCheckoutType, returnPath?: string) {
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
        const { cancelPath, successPath } = this.resolveCheckoutReturnPaths(returnPath);
        const cancelUrl = this.buildAbsoluteAppUrl(cancelPath);
        const successUrl = this.buildCheckoutSuccessUrl(successPath);

        if (type === BILLING_CHECKOUT_TYPES.SUBSCRIPTION) {
            if (env.STRIPE_SUBSCRIPTION_PRICE_ID == null) {
                throw new Error("STRIPE_SUBSCRIPTION_PRICE_ID is not configured");
            }

            const session = await stripe.checkout.sessions.create({
                mode: "subscription",
                customer: customer.stripeCustomerId,
                line_items: [{ price: env.STRIPE_SUBSCRIPTION_PRICE_ID, quantity: 1 }],
                payment_method_collection: "always",
                success_url: successUrl,
                cancel_url: cancelUrl,
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
            success_url: successUrl,
            cancel_url: cancelUrl,
        });

        this.logger.info("Created topup checkout session", { organizationId, sessionId: session.id });
        return { url: session.url };
    }

    async createPortalSession(organizationId: string, returnPath?: string) {
        const org = await this.db.organization.findUnique({
            where: { id: organizationId },
            select: { name: true },
        });
        if (org == null) throw new NotFoundError("Organization not found");

        const customer = await this.getOrCreateCustomer(organizationId, org.name ?? organizationId);
        if (customer.stripeCustomerId == null) {
            throw new Error(`Stripe customer missing for organization ${organizationId}`);
        }

        const { cancelPath } = this.resolveCheckoutReturnPaths(returnPath);
        const returnUrl = this.buildAbsoluteAppUrl(cancelPath);
        const stripe = getStripe();
        const session = await stripe.billingPortal.sessions.create({
            customer: customer.stripeCustomerId,
            return_url: returnUrl,
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
                cliCreditsSpent: 0,
                transactions: [],
            };
        }

        // All-time spend through the managed LLM proxy (planner CLI). The
        // transactions list above is capped at 20, so we aggregate separately to
        // surface the lifetime total in the billing UI.
        const llmProxyAggregate = await this.db.creditTransaction.aggregate({
            where: { organizationId, type: CreditTransactionType.LLM_PROXY_CONSUMPTION },
            _sum: { amount: true },
        });
        const cliCreditsSpent = Math.abs(llmProxyAggregate._sum.amount ?? 0);

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
            cliCreditsSpent,
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
