import type { ApplicationArchitecture, PrismaClient } from "@autonoma/db";
import type { BillingCheckoutType } from "@autonoma/types";
import { AutoTopUpService } from "./auto-topup.service";
import { BillingCustomerService } from "./billing-customer.service";
import { BillingPricingService } from "./billing-pricing.service";
import { BillingPromoService } from "./billing-promo.service";
import { CreditsService } from "./credits.service";
import type { BillingConsumptionTarget, BillingService, DeductGenerationContext, StripeBillingService } from "./types";

export class EnabledBillingService implements BillingService, StripeBillingService {
    private readonly billingCustomerService: BillingCustomerService;
    private readonly creditsService: CreditsService;
    private readonly billingPricingService: BillingPricingService;
    private readonly billingPromoService: BillingPromoService;

    constructor(db: PrismaClient) {
        this.billingPricingService = new BillingPricingService(db);
        const autoTopUpService = new AutoTopUpService(db);
        this.billingCustomerService = new BillingCustomerService(db);
        this.billingPromoService = new BillingPromoService(db);
        this.creditsService = new CreditsService(db, autoTopUpService, this.billingPricingService);
    }

    async getOrCreateCustomer(organizationId: string, orgName: string) {
        const customer = await this.billingCustomerService.getOrCreateCustomer(organizationId, orgName);
        await this.billingPricingService.getOrCreatePricing(organizationId);
        return customer;
    }

    createCheckoutSession(organizationId: string, type: BillingCheckoutType) {
        return this.billingCustomerService.createCheckoutSession(organizationId, type);
    }

    createPortalSession(organizationId: string) {
        return this.billingCustomerService.createPortalSession(organizationId);
    }

    getBillingStatus(organizationId: string) {
        return this.billingCustomerService.getBillingStatus(organizationId);
    }

    updateAutoTopUp(organizationId: string, enabled: boolean, threshold: number) {
        return this.billingCustomerService.updateAutoTopUp(organizationId, enabled, threshold);
    }

    checkCreditsGate(
        organizationId: string,
        runCount: number,
        architecture: ApplicationArchitecture,
        target: BillingConsumptionTarget = "generation",
    ) {
        return this.creditsService.checkCreditsGate(organizationId, runCount, architecture, target);
    }

    deductCreditsForGeneration(generationId: string, context?: DeductGenerationContext) {
        return this.creditsService.deductCreditsForGeneration(generationId, context);
    }

    deductCreditsForRun(runId: string) {
        return this.creditsService.deductCreditsForRun(runId);
    }

    refundCreditsForGeneration(generationId: string) {
        return this.creditsService.refundCreditsForGeneration(generationId);
    }

    grantSubscriptionCredits(organizationId: string, stripeInvoiceId: string) {
        return this.creditsService.grantSubscriptionCredits(organizationId, stripeInvoiceId);
    }

    grantTopupCredits(organizationId: string, stripePaymentIntentId: string) {
        return this.creditsService.grantTopupCredits(organizationId, stripePaymentIntentId);
    }

    revokeTopupCredits(
        organizationId: string,
        stripeRefundId: string,
        stripePaymentIntentId: string,
        refundedAmountCents: number,
        originalChargedAmountCents: number,
    ) {
        return this.creditsService.revokeTopupCredits(
            organizationId,
            stripeRefundId,
            stripePaymentIntentId,
            refundedAmountCents,
            originalChargedAmountCents,
        );
    }

    syncFromStripe(stripeCustomerId: string) {
        return this.billingCustomerService.syncFromStripe(stripeCustomerId);
    }

    findCustomerByStripeId(stripeCustomerId: string) {
        return this.billingCustomerService.findCustomerByStripeId(stripeCustomerId);
    }

    startGracePeriodByStripeCustomerId(stripeCustomerId: string, gracePeriodDays: number) {
        return this.billingCustomerService.startGracePeriodByStripeCustomerId(stripeCustomerId, gracePeriodDays);
    }

    clearGracePeriodByStripeCustomerId(stripeCustomerId: string) {
        return this.billingCustomerService.clearGracePeriodByStripeCustomerId(stripeCustomerId);
    }

    redeemPromoCode(organizationId: string, code: string) {
        return this.billingPromoService.redeemPromoCode(organizationId, code);
    }
}
