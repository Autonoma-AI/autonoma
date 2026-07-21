import { ApplicationArchitecture, Prisma } from "@autonoma/db";
import type { BillingPricingValues } from "./billing-pricing.types";

export function isUniqueConstraintError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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

/**
 * Raw (possibly fractional, possibly zero) credit cost of one usage window's
 * measured compute, at the org's flat per-hour rates. Not rounded - callers
 * decide how to turn this into a whole-credit charge.
 */
export function computePreviewUsageCost(vcpuSeconds: number, gbSeconds: number, pricing: BillingPricingValues) {
    const vcpuCost = (vcpuSeconds / 3600) * pricing.creditsPerVcpuHour;
    const gbCost = (gbSeconds / 3600) * pricing.creditsPerGbMemoryHour;
    return vcpuCost + gbCost;
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
