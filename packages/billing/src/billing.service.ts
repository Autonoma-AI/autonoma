import type { PrismaClient } from "@autonoma/db";
import { DisabledBillingService } from "./billing-disabled.service";
import { EnabledBillingService } from "./billing-enabled.service";
import { env } from "./env";
import type { BillingService, StripeBillingService } from "./types";

export type { BillingService, StripeBillingService } from "./types";
export type BillingServices = {
    billingService: BillingService;
    stripeBillingService: StripeBillingService | null;
};

export function createBillingServices(db: PrismaClient): BillingServices {
    if (env.STRIPE_ENABLED) {
        const service = new EnabledBillingService(db);
        return {
            billingService: service,
            stripeBillingService: service,
        };
    }

    return {
        billingService: new DisabledBillingService(db),
        stripeBillingService: null,
    };
}

export function createBillingService(db: PrismaClient): BillingService {
    return createBillingServices(db).billingService;
}

export function createStripeBillingService(db: PrismaClient): StripeBillingService | null {
    return createBillingServices(db).stripeBillingService;
}
