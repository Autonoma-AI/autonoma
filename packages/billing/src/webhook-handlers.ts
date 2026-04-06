import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { BILLING_PAYMENT_INTENT_TYPES, BILLING_STRIPE_SUBSCRIPTION_SYNC_EVENT_TYPES } from "@autonoma/types";
import type Stripe from "stripe";
import { type StripeBillingService, createBillingServices } from "./billing.service";
import { env } from "./env";
import { getStripe } from "./stripe-client";
import { syncStripeDataToDb } from "./stripe-sync";

type StripeWebhookHandler = (event: Stripe.Event, billingService: StripeBillingService) => Promise<void>;
const STRIPE_INVOICE_PARENT_TYPE_SUBSCRIPTION_DETAILS = "subscription_details" as const;

const webhookHandlers: Partial<Record<Stripe.Event.Type, StripeWebhookHandler>> = {
    "invoice.paid": handleInvoicePaid,
    "invoice.payment_failed": handleInvoicePaymentStateChange,
    "invoice.payment_action_required": handleInvoicePaymentStateChange,
    "payment_intent.succeeded": handlePaymentIntentSucceeded,
    "checkout.session.completed": handleCheckoutSessionCompleted,
    "refund.created": handleRefundCreated,
};

for (const eventType of BILLING_STRIPE_SUBSCRIPTION_SYNC_EVENT_TYPES) {
    webhookHandlers[eventType] = handleSubscriptionSync;
}

export async function processWebhookEvent(event: Stripe.Event): Promise<void> {
    const { stripeBillingService: billingService } = createBillingServices(db);
    if (billingService == null) {
        logger.info("Ignoring Stripe webhook event because STRIPE_ENABLED=false", {
            type: event.type,
            id: event.id,
        });
        return;
    }

    logger.info("Processing Stripe webhook event", { type: event.type, id: event.id });
    const handler = webhookHandlers[event.type as Stripe.Event.Type];

    if (handler == null) {
        logger.info("Stripe webhook event not handled", { type: event.type });
        return;
    }

    await handler(event, billingService);
}

async function handleSubscriptionSync(event: Stripe.Event): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription;
    await syncCustomerByRef(subscription.customer);
}

async function handleInvoicePaid(event: Stripe.Event, billingService: StripeBillingService): Promise<void> {
    const invoice = event.data.object as Stripe.Invoice;
    const stripeCustomerId = await syncCustomerByRef(invoice.customer);
    if (stripeCustomerId == null) return;

    await billingService.clearGracePeriodByStripeCustomerId(stripeCustomerId);

    const isSubscriptionInvoice = isSubscriptionInvoiceParent(invoice);
    if (!isSubscriptionInvoice) return;

    const customer = await billingService.findCustomerByStripeId(stripeCustomerId);
    if (customer == null) {
        logger.warn("No BillingCustomer found for Stripe customer on invoice.paid", { stripeCustomerId });
        return;
    }

    await billingService.grantSubscriptionCredits(
        customer.organizationId,
        invoice.id,
        invoice.customer_email ?? undefined,
    );
}

async function handleInvoicePaymentStateChange(
    event: Stripe.Event,
    billingService: StripeBillingService,
): Promise<void> {
    const invoice = event.data.object as Stripe.Invoice;
    const stripeCustomerId = await syncCustomerByRef(invoice.customer);
    if (stripeCustomerId == null) return;

    const isSubscriptionInvoice = isSubscriptionInvoiceParent(invoice);
    if (!isSubscriptionInvoice) return;

    await billingService.startGracePeriodByStripeCustomerId(stripeCustomerId, env.BILLING_GRACE_PERIOD_DAYS);
}

async function handlePaymentIntentSucceeded(event: Stripe.Event, billingService: StripeBillingService): Promise<void> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const paymentIntentType = paymentIntent.metadata.type;
    const organizationId = paymentIntent.metadata.organizationId;
    if (paymentIntentType !== BILLING_PAYMENT_INTENT_TYPES.TOPUP || organizationId == null) return;
    await billingService.grantTopupCredits(organizationId, paymentIntent.id, paymentIntent.receipt_email ?? undefined);
}

async function handleCheckoutSessionCompleted(event: Stripe.Event): Promise<void> {
    const session = event.data.object as Stripe.Checkout.Session;
    await syncCustomerByRef(session.customer);
}

async function handleRefundCreated(event: Stripe.Event, billingService: StripeBillingService): Promise<void> {
    const refund = event.data.object as Stripe.Refund;
    const refundId = refund.id;
    if (refund.status !== "succeeded") {
        logger.info("Refund not succeeded yet, skipping credit revoke", { refundId, status: refund.status });
        return;
    }
    const refundedAmountCents = refund.amount;
    const chargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id;

    if (chargeId == null) {
        logger.warn("Refund has no charge reference, skipping credit revoke", { refundId });
        return;
    }

    const stripe = getStripe();
    const charge = await stripe.charges.retrieve(chargeId);
    const paymentType = charge.metadata.type;
    const organizationId = charge.metadata.organizationId;
    const paymentIntentId =
        typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;

    if (paymentType !== BILLING_PAYMENT_INTENT_TYPES.TOPUP || organizationId == null) {
        logger.info("Refund is not a top-up credit purchase, skipping", {
            refundId,
            chargeId,
            paymentType,
            organizationId,
        });
        return;
    }

    if (paymentIntentId == null) {
        logger.warn("Refund charge has no payment_intent reference, skipping credit revoke", {
            refundId,
            chargeId,
            organizationId,
        });
        return;
    }

    await billingService.revokeTopupCredits(
        organizationId,
        refundId,
        paymentIntentId,
        refundedAmountCents,
        charge.amount,
    );
}

function extractCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
    if (customer == null) return null;
    if (typeof customer === "string") return customer;
    return customer.id;
}

async function syncCustomerByRef(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null) {
    const stripeCustomerId = extractCustomerId(customer);
    if (stripeCustomerId == null) return null;
    await syncStripeDataToDb(stripeCustomerId, db);
    return stripeCustomerId;
}

function isSubscriptionInvoiceParent(invoice: Stripe.Invoice): boolean {
    return invoice.parent?.type === STRIPE_INVOICE_PARENT_TYPE_SUBSCRIPTION_DETAILS;
}
