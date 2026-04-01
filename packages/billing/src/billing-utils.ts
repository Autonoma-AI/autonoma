import { ApplicationArchitecture, Prisma } from "@autonoma/db";
import type { BillingPricingValues } from "./billing-pricing.types";

export function isUniqueConstraintError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function getRunCreditCost(architecture: ApplicationArchitecture, pricing: BillingPricingValues) {
    switch (architecture) {
        case ApplicationArchitecture.WEB:
            return pricing.creditsWebRunCost;
        case ApplicationArchitecture.IOS:
            return pricing.creditsIosRunCost;
        case ApplicationArchitecture.ANDROID:
            return pricing.creditsAndroidRunCost;
    }
}

export function getGenerationCreditCost(architecture: ApplicationArchitecture, pricing: BillingPricingValues) {
    switch (architecture) {
        case ApplicationArchitecture.WEB:
            return pricing.creditsWebGenerationCost;
        case ApplicationArchitecture.IOS:
            return pricing.creditsIosGenerationCost;
        case ApplicationArchitecture.ANDROID:
            return pricing.creditsAndroidGenerationCost;
    }
}

export function buildAutoTopUpIdempotencyKey(organizationId: string) {
    const fiveMinuteBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    return `auto-topup:${organizationId}:${fiveMinuteBucket}`;
}

export function buildCustomerCreateIdempotencyKey(organizationId: string) {
    return `billing-customer:${organizationId}`;
}

export function normalizePromoCode(code: string) {
    return code.trim().toUpperCase();
}
