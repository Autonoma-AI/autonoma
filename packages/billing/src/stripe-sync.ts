import { type PrismaClient, SubscriptionStatus } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { getStripe } from "./stripe-client";

/**
 * Syncs Stripe subscription data into the BillingCustomer record.
 */
export async function syncStripeDataToDb(stripeCustomerId: string, db: PrismaClient): Promise<void> {
    const stripe = getStripe();

    Sentry.addBreadcrumb({
        category: "billing",
        level: "info",
        message: "Syncing Stripe data to DB",
        data: { stripeCustomerId },
    });

    const subscriptions = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        limit: 1,
        status: "all",
    });

    const subscription = subscriptions.data[0];

    if (subscription == null) {
        const result = await db.billingCustomer.updateMany({
            where: { stripeCustomerId },
            data: {
                subscriptionId: null,
                subscriptionStatus: null,
                priceId: null,
                currentPeriodStart: null,
                currentPeriodEnd: null,
                cancelAtPeriodEnd: false,
            },
        });
        if (result.count === 0) {
            logger.warn("Stripe sync skipped - no billing customer found for stripe customer", { stripeCustomerId });
        }

        Sentry.addBreadcrumb({
            category: "billing",
            level: "info",
            message: "No active subscription found - cleared subscription fields",
            data: { stripeCustomerId, updatedCustomers: result.count },
        });
        return;
    }

    const subscriptionItem = subscription.items.data[0];
    const priceId = subscriptionItem?.price.id ?? null;
    const currentPeriodStart =
        subscriptionItem?.current_period_start != null ? new Date(subscriptionItem.current_period_start * 1000) : null;
    const currentPeriodEnd =
        subscriptionItem?.current_period_end != null ? new Date(subscriptionItem.current_period_end * 1000) : null;

    const result = await db.billingCustomer.updateMany({
        where: { stripeCustomerId },
        data: {
            subscriptionId: subscription.id,
            subscriptionStatus: mapSubscriptionStatus(subscription.status),
            priceId,
            currentPeriodStart,
            currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
        },
    });
    if (result.count === 0) {
        logger.warn("Stripe sync skipped - no billing customer found for stripe customer", { stripeCustomerId });
    }

    Sentry.addBreadcrumb({
        category: "billing",
        level: "info",
        message: "Stripe subscription data synced",
        data: {
            stripeCustomerId,
            subscriptionId: subscription.id,
            status: subscription.status,
            updatedCustomers: result.count,
        },
    });
}

const subscriptionStatuses = new Set<SubscriptionStatus>(Object.values(SubscriptionStatus));

function mapSubscriptionStatus(status: string): SubscriptionStatus | null {
    return subscriptionStatuses.has(status as SubscriptionStatus) ? (status as SubscriptionStatus) : null;
}
