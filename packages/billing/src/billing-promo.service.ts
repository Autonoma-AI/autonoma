import { CreditTransactionType, type PrismaClient } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import { ensureBillingProvisioning } from "./billing-provisioning";
import { isUniqueConstraintError, normalizePromoCode } from "./billing-utils";
import { Service } from "./service";
import type {
    BillingPromoCodeItem,
    CreatePromoCodeInput,
    ListPromoCodesInput,
    ListPromoCodesResult,
    RedeemPromoCodeResult,
} from "./types";

export class BillingPromoService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async redeemPromoCode(organizationId: string, code: string): Promise<RedeemPromoCodeResult> {
        const normalizedCode = normalizePromoCode(code);
        if (normalizedCode.length === 0) {
            throw new BadRequestError("Promo code is required");
        }

        await ensureBillingProvisioning(this.db, organizationId);

        const now = new Date();

        return this.db.$transaction(async (tx) => {
            const promo = await tx.billingPromoCode.findUnique({
                where: { code: normalizedCode },
                select: {
                    id: true,
                    code: true,
                    grantCredits: true,
                    maxRedemptions: true,
                    redeemedCount: true,
                    isActive: true,
                    startsAt: true,
                    endsAt: true,
                },
            });

            if (promo == null) {
                throw new BadRequestError("Invalid promo code");
            }

            if (!promo.isActive) {
                throw new BadRequestError("Promo code is inactive");
            }
            if (promo.startsAt != null && promo.startsAt > now) {
                throw new BadRequestError("Promo code is not active yet");
            }
            if (promo.endsAt != null && promo.endsAt <= now) {
                throw new BadRequestError("Promo code has expired");
            }

            const existingRedemption = await tx.billingPromoRedemption.findFirst({
                where: {
                    promoCodeId: promo.id,
                    organizationId,
                },
                select: { id: true },
            });

            if (existingRedemption != null) {
                throw new BadRequestError("Promo code already redeemed for this organization");
            }

            const claimResult = await tx.billingPromoCode.updateMany({
                where: {
                    id: promo.id,
                    ...(promo.maxRedemptions == null ? {} : { redeemedCount: { lt: promo.maxRedemptions } }),
                },
                data: {
                    redeemedCount: {
                        increment: 1,
                    },
                },
            });

            if (claimResult.count === 0) {
                throw new BadRequestError("Promo code redemption limit reached");
            }

            let redemptionId: string;
            try {
                const redemption = await tx.billingPromoRedemption.create({
                    data: {
                        promoCodeId: promo.id,
                        organizationId,
                    },
                });
                redemptionId = redemption.id;
            } catch (error) {
                if (isUniqueConstraintError(error)) {
                    throw new BadRequestError("Promo code already redeemed for this organization");
                }
                throw error;
            }

            const updatedCustomer = await tx.billingCustomer.update({
                where: { organizationId },
                data: {
                    creditBalance: {
                        increment: promo.grantCredits,
                    },
                },
                select: {
                    creditBalance: true,
                },
            });

            await tx.creditTransaction.create({
                data: {
                    organizationId,
                    type: CreditTransactionType.PROMO_GRANT,
                    amount: promo.grantCredits,
                    balanceAfter: updatedCustomer.creditBalance,
                    promoRedemptionId: redemptionId,
                },
            });

            const remainingRedemptions =
                promo.maxRedemptions == null ? null : Math.max(0, promo.maxRedemptions - (promo.redeemedCount + 1));

            this.logger.info("Promo code redeemed", {
                organizationId,
                promoCode: promo.code,
                grantedCredits: promo.grantCredits,
                remainingRedemptions,
                newBalance: updatedCustomer.creditBalance,
            });

            return {
                promoCode: promo.code,
                grantedCredits: promo.grantCredits,
                newBalance: updatedCustomer.creditBalance,
                remainingRedemptions,
            };
        });
    }

    async listPromoCodes(input?: ListPromoCodesInput): Promise<ListPromoCodesResult> {
        const page = Math.max(1, input?.page ?? 1);
        const pageSize = Math.min(100, Math.max(1, input?.pageSize ?? 20));
        const query = input?.query?.trim();
        const where = {
            ...(query != null && query.length > 0
                ? {
                      OR: [
                          { code: { contains: query, mode: "insensitive" as const } },
                          { description: { contains: query, mode: "insensitive" as const } },
                      ],
                  }
                : {}),
            ...(typeof input?.isActive === "boolean" ? { isActive: input.isActive } : {}),
        };

        const [total, items] = await this.db.$transaction([
            this.db.billingPromoCode.count({ where }),
            this.db.billingPromoCode.findMany({
                where,
                orderBy: [{ createdAt: "desc" }],
                skip: (page - 1) * pageSize,
                take: pageSize,
                select: {
                    id: true,
                    code: true,
                    description: true,
                    grantCredits: true,
                    maxRedemptions: true,
                    redeemedCount: true,
                    startsAt: true,
                    endsAt: true,
                    isActive: true,
                    createdAt: true,
                    updatedAt: true,
                },
            }),
        ]);

        return {
            items,
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
        };
    }

    async createPromoCode(input: CreatePromoCodeInput): Promise<BillingPromoCodeItem> {
        const code = normalizePromoCode(input.code);
        if (code.length === 0) {
            throw new BadRequestError("Promo code is required");
        }
        if (input.grantCredits <= 0) {
            throw new BadRequestError("Grant credits must be greater than 0");
        }
        if (input.maxRedemptions != null && input.maxRedemptions <= 0) {
            throw new BadRequestError("Max redemptions must be greater than 0");
        }

        try {
            return await this.db.billingPromoCode.create({
                data: {
                    code,
                    description: input.description?.trim() || null,
                    grantCredits: input.grantCredits,
                    maxRedemptions: input.maxRedemptions ?? null,
                    endsAt: input.endsAt ?? null,
                    isActive: true,
                },
                select: {
                    id: true,
                    code: true,
                    description: true,
                    grantCredits: true,
                    maxRedemptions: true,
                    redeemedCount: true,
                    startsAt: true,
                    endsAt: true,
                    isActive: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });
        } catch (error) {
            if (isUniqueConstraintError(error)) {
                throw new BadRequestError("Promo code already exists");
            }
            throw error;
        }
    }

    async setPromoCodeActive(promoCodeId: string, isActive: boolean): Promise<BillingPromoCodeItem> {
        const existing = await this.db.billingPromoCode.findUnique({
            where: { id: promoCodeId },
            select: { id: true },
        });
        if (existing == null) {
            throw new BadRequestError("Promo code not found");
        }
        return this.db.billingPromoCode.update({
            where: { id: promoCodeId },
            data: { isActive },
            select: {
                id: true,
                code: true,
                description: true,
                grantCredits: true,
                maxRedemptions: true,
                redeemedCount: true,
                startsAt: true,
                endsAt: true,
                isActive: true,
                createdAt: true,
                updatedAt: true,
            },
        });
    }
}
