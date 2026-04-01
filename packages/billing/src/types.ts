import type { ApplicationArchitecture, BillingCustomer, CreditTransaction } from "@autonoma/db";
import type { BillingCheckoutType } from "@autonoma/types";

export type RedeemPromoCodeResult = {
    promoCode: string;
    grantedCredits: number;
    newBalance: number;
    remainingRedemptions: number | null;
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
    createCheckoutSession(organizationId: string, type: BillingCheckoutType): Promise<BillingSessionResult>;
    createPortalSession(organizationId: string): Promise<BillingSessionResult>;
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
}

export interface StripeBillingService {
    grantSubscriptionCredits(organizationId: string, stripeInvoiceId: string): Promise<void>;
    grantTopupCredits(organizationId: string, stripePaymentIntentId: string): Promise<void>;
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
