export type DeductCreditsResultRow = {
    inserted_count: bigint;
    new_balance: number | null;
    new_subscription_balance: number | null;
};

export type SubscriptionGrantCustomerRow = {
    credit_balance: number;
    subscription_credit_balance: number;
};

export type TopupRefundResultRow = {
    inserted_count: bigint;
    new_balance: number | null;
};

export type GenerationRefundResultRow = {
    consumed_count: bigint;
    inserted_count: bigint;
    refunded_amount: number | null;
    new_balance: number | null;
    new_subscription_balance: number | null;
};
