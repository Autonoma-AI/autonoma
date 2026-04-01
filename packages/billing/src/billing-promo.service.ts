import { CreditTransactionType, type PrismaClient } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import { ensureBillingProvisioning } from "./billing-provisioning";
import { isUniqueConstraintError, normalizePromoCode } from "./billing-utils";
import { Service } from "./service";
import type { RedeemPromoCodeResult } from "./types";

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
}
