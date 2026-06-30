export const CHECKOUT_TYPE_SUBSCRIPTION = "subscription" as const;
export const CHECKOUT_TYPE_TOPUP = "topup" as const;

export type CheckoutType = typeof CHECKOUT_TYPE_SUBSCRIPTION | typeof CHECKOUT_TYPE_TOPUP;

// Human-readable labels for CreditTransactionType. Keyed by the enum string so a
// new transaction type renders its raw value (still legible) until added here.
const TRANSACTION_TYPE_LABELS: Record<string, string> = {
    SUBSCRIPTION_GRANT: "Subscription credits",
    SUBSCRIPTION_RESET: "Subscription reset",
    FREE_START_GRANT: "Free starter credits",
    PROMO_GRANT: "Promo credits",
    TOPUP_PURCHASE: "Top-up purchase",
    TOPUP_REFUND: "Top-up refund",
    GENERATION_CONSUMPTION: "Test generation",
    GENERATION_REFUND: "Generation refund",
    RUN_CONSUMPTION: "Test run",
    LLM_PROXY_CONSUMPTION: "AI CLI usage",
};

export function formatTransactionType(type: string): string {
    return TRANSACTION_TYPE_LABELS[type] ?? type;
}

export function formatSubscriptionStatus(status: string | undefined) {
    if (status == null) return "No subscription";

    switch (status) {
        case "active":
            return "Active";
        case "trialing":
            return "Trialing";
        case "past_due":
            return "Past due";
        case "unpaid":
            return "Unpaid";
        case "paused":
            return "Paused";
        case "incomplete":
            return "Incomplete";
        case "incomplete_expired":
            return "Incomplete expired";
        case "canceled":
            return "Canceled";
        default:
            return status;
    }
}
