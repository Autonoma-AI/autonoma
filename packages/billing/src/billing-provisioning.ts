import { CreditTransactionType, type PrismaClient } from "@autonoma/db";
import { isUniqueConstraintError } from "./billing-utils";

export async function ensureBillingProvisioning(db: PrismaClient, organizationId: string) {
    const existing = await db.billingCustomer.findUnique({
        where: { organizationId },
    });
    if (existing != null) return existing;

    const pricing = await db.billingPricing.upsert({
        where: { organizationId },
        create: { organizationId },
        update: {},
        select: { creditsFreeStart: true },
    });

    try {
        return await db.$transaction(async (tx) => {
            const created = await tx.billingCustomer.create({
                data: {
                    organizationId,
                    creditBalance: pricing.creditsFreeStart,
                },
            });

            await tx.creditTransaction.create({
                data: {
                    id: `ctr_free_start_${organizationId}`,
                    organizationId,
                    type: CreditTransactionType.FREE_START_GRANT,
                    amount: pricing.creditsFreeStart,
                    balanceAfter: pricing.creditsFreeStart,
                },
            });

            return created;
        });
    } catch (error) {
        if (isUniqueConstraintError(error)) {
            const customer = await db.billingCustomer.findUnique({
                where: { organizationId },
            });
            if (customer != null) return customer;
        }

        throw error;
    }
}
