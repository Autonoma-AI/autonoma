import type { ApplicationArchitecture, PrismaClient } from "@autonoma/db";
import type { BillingCheckoutType } from "@autonoma/types";
import { BillingCustomerService } from "./billing-customer.service";
import { BillingPricingService } from "./billing-pricing.service";
import { BillingPromoService } from "./billing-promo.service";
import type { BillingConsumptionTarget, BillingService, DeductGenerationContext } from "./types";

export class DisabledBillingService implements BillingService {
    private readonly billingCustomerService: BillingCustomerService;
    private readonly billingPricingService: BillingPricingService;
    private readonly billingPromoService: BillingPromoService;

    constructor(db: PrismaClient) {
        this.billingPricingService = new BillingPricingService(db);
        this.billingCustomerService = new BillingCustomerService(db);
        this.billingPromoService = new BillingPromoService(db);
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
        _organizationId: string,
        _runCount: number,
        _architecture: ApplicationArchitecture,
        _target: BillingConsumptionTarget = "generation",
    ) {
        return Promise.resolve();
    }

    deductCreditsForGeneration(_generationId: string, _context?: DeductGenerationContext) {
        return Promise.resolve(false);
    }

    deductCreditsForRun(_runId: string) {
        return Promise.resolve(false);
    }

    refundCreditsForGeneration(_generationId: string) {
        return Promise.resolve();
    }

    redeemPromoCode(organizationId: string, code: string) {
        return this.billingPromoService.redeemPromoCode(organizationId, code);
    }

    listPromoCodes(input?: Parameters<BillingPromoService["listPromoCodes"]>[0]) {
        return this.billingPromoService.listPromoCodes(input);
    }

    createPromoCode(input: Parameters<BillingPromoService["createPromoCode"]>[0]) {
        return this.billingPromoService.createPromoCode(input);
    }

    setPromoCodeActive(promoCodeId: string, isActive: boolean) {
        return this.billingPromoService.setPromoCodeActive(promoCodeId, isActive);
    }
}
