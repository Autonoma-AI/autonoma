import { CreditTransactionType, type PrismaClient } from "@autonoma/db";
import { isUniqueConstraintError } from "./billing-utils";

export interface BillingProvisioningOptions {
    /**
     * Grant the free starting credits when this organization has no billing customer yet.
     *
     * Off by default, and that default is the security property. "Has no customer" is not evidence of
     * a new organization - 8500 production organizations have none - so funding on that basis turned
     * every path that could bring an organization into existence into a mint. One account could create
     * an organization, make it active, sign in again and collect another full starting balance, then
     * repeat. Pass `true` only where an organization is genuinely being created for someone.
     */
    grantFreeStart?: boolean;
}

export async function ensureBillingProvisioning(
    db: PrismaClient,
    organizationId: string,
    { grantFreeStart = false }: BillingProvisioningOptions = {},
) {
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

    // An org created via the Vercel Marketplace install flow (see
    // vercel-installations.router.ts) must be provisioned with provider "vercel"
    // from the start - this can run before that flow provisions its own resource
    // (e.g. a Vercel SSO login right after install, before a project is
    // connected), so relying on that flow's own guard alone leaves the row
    // permanently mislabeled "stripe" whenever this runs first.
    const vercelInstallation = await db.vercelInstallation.findFirst({
        where: { organizationId },
        select: { id: true },
    });
    const provider = vercelInstallation != null ? "vercel" : undefined;

    const creditBalance = grantFreeStart ? pricing.creditsFreeStart : 0;

    try {
        return await db.$transaction(async (tx) => {
            const created = await tx.billingCustomer.create({
                data: {
                    organizationId,
                    creditBalance,
                    provider,
                },
            });

            // No ledger row when nothing was granted - a zero-amount FREE_START_GRANT would claim a
            // grant that did not happen.
            //
            // Note the consequence: a customer row at zero makes the early return above permanent, so
            // the grant cannot arrive later. That is safe only because the grant belongs to the moment
            // an organization is created, which is the first provisioning it ever sees - keep it that
            // way, and do not add a caller that provisions an organization before it is granted.
            if (creditBalance > 0) {
                await tx.creditTransaction.create({
                    data: {
                        id: `ctr_free_start_${organizationId}`,
                        organizationId,
                        type: CreditTransactionType.FREE_START_GRANT,
                        amount: creditBalance,
                        balanceAfter: creditBalance,
                    },
                });
            }

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
