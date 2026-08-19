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

/**
 * Whole-credit charge for a USD amount, converted at the same rate top-ups are priced
 * (`creditsPerTopup` per `stripeTopupAmountCents`), so the existing margin carries over and there's
 * no separate pricing knob. Any real spend costs at least one credit.
 *
 * Returns `undefined` when the org's row yields no usable exchange rate - a zero
 * `stripeTopupAmountCents` (which would divide to an infinite rate and charge an unbounded number of
 * credits) or a zero `creditsPerTopup`. Neither is reachable through the app, which never writes
 * either column, so it means a hand-edited row: callers skip the deduction and log rather than
 * charge a garbage amount.
 */
export function usdToCreditCost(costUsd: number, pricing: BillingPricingValues): number | undefined {
    const creditsPerUsd = pricing.creditsPerTopup / (pricing.stripeTopupAmountCents / 100);
    if (!Number.isFinite(creditsPerUsd) || creditsPerUsd <= 0) return undefined;
    return Math.max(1, Math.ceil(costUsd * creditsPerUsd));
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
