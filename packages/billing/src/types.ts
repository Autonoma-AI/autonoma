import type { ApplicationArchitecture, BillingCustomer, CreditTransaction } from "@autonoma/db";
import type { BillingCheckoutType } from "@autonoma/types";

export type RedeemPromoCodeResult = {
    promoCode: string;
    grantedCredits: number;
    newBalance: number;
    remainingRedemptions: number | null;
};

export type BillingPromoCodeItem = {
    id: string;
    code: string;
    description: string | null;
    grantCredits: number;
    maxRedemptions: number | null;
    redeemedCount: number;
    startsAt: Date | null;
    endsAt: Date | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
};

export type CreatePromoCodeInput = {
    code: string;
    description?: string | null;
    grantCredits: number;
    maxRedemptions?: number | null;
    endsAt?: Date | null;
};

export type ListPromoCodesInput = {
    page?: number;
    pageSize?: number;
    query?: string;
    isActive?: boolean;
};

export type ListPromoCodesResult = {
    items: BillingPromoCodeItem[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
};

export type BillingConsumptionTarget = "generation" | "run";
export type DeductGenerationContext = {
    organizationId?: string;
    architecture?: ApplicationArchitecture;
    isRerun?: boolean;
};

export type BillingSessionResult = {
    url: string | null;
};

export type BillingStatusResult = {
    creditBalance: number;
    subscriptionCreditBalance: number;
    topupCreditBalance: number;
    subscriptionStatus: string | undefined;
    currentPeriodEnd: Date | undefined;
    cancelAtPeriodEnd: boolean;
    gracePeriodEndsAt: Date | undefined;
    autoTopUpEnabled: boolean;
    autoTopUpThreshold: number;
    transactions: CreditTransaction[];
};

export interface BillingService {
    getOrCreateCustomer(organizationId: string, orgName: string): Promise<BillingCustomer>;
    createCheckoutSession(
        organizationId: string,
        type: BillingCheckoutType,
        returnPath?: string,
    ): Promise<BillingSessionResult>;
    createPortalSession(organizationId: string, returnPath?: string): Promise<BillingSessionResult>;
    getBillingStatus(organizationId: string): Promise<BillingStatusResult>;
    updateAutoTopUp(organizationId: string, enabled: boolean, threshold: number): Promise<void>;
    checkCreditsGate(
        organizationId: string,
        runCount: number,
        architecture: ApplicationArchitecture,
        target?: BillingConsumptionTarget,
    ): Promise<void>;
    deductCreditsForGeneration(generationId: string, context?: DeductGenerationContext): Promise<boolean>;
    deductCreditsForRun(runId: string): Promise<boolean>;
    refundCreditsForGeneration(generationId: string): Promise<void>;
    redeemPromoCode(organizationId: string, code: string): Promise<RedeemPromoCodeResult>;
    listPromoCodes(input?: ListPromoCodesInput): Promise<ListPromoCodesResult>;
    createPromoCode(input: CreatePromoCodeInput): Promise<BillingPromoCodeItem>;
    setPromoCodeActive(promoCodeId: string, isActive: boolean): Promise<BillingPromoCodeItem>;
}

export interface StripeBillingService {
    grantSubscriptionCredits(organizationId: string, stripeInvoiceId: string, customerEmail?: string): Promise<void>;
    grantTopupCredits(organizationId: string, stripePaymentIntentId: string, customerEmail?: string): Promise<void>;
    revokeTopupCredits(
        organizationId: string,
        stripeRefundId: string,
        stripePaymentIntentId: string,
        refundedAmountCents: number,
        originalChargedAmountCents: number,
    ): Promise<void>;
    syncFromStripe(stripeCustomerId: string): Promise<void>;
    findCustomerByStripeId(stripeCustomerId: string): Promise<BillingCustomer | null>;
    startGracePeriodByStripeCustomerId(stripeCustomerId: string, gracePeriodDays: number): Promise<void>;
    clearGracePeriodByStripeCustomerId(stripeCustomerId: string): Promise<void>;
}
