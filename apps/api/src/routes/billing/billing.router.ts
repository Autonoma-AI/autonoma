import { resolveFreeStartEligibility } from "@autonoma/billing";
import { BILLING_CHECKOUT_TYPES } from "@autonoma/types";
import { z } from "zod";
import { protectedProcedure, writeProcedure, router } from "../../trpc";

const billingRouterImpl = router({
    status: protectedProcedure.query(({ ctx: { services, organizationId } }) =>
        services.billing.getBillingStatus(organizationId),
    ),
    /**
     * Just the subscription enum, read by the app shell's upgrade button on every page.
     *
     * Separate from `status` so the shell does not pull a credit balance, a lifetime aggregate and
     * the last 20 transactions to decide whether to render one button.
     */
    subscriptionStatus: protectedProcedure.query(({ ctx: { services, organizationId } }) =>
        services.billing.getSubscriptionStatus(organizationId),
    ),
    /**
     * Whether this account would receive the free starting credits in a new organization, and which
     * organizations spent that entitlement if not.
     *
     * Keyed on the user rather than the active organization on purpose: the entitlement is per person,
     * which is the whole point of it. Read by the UI so "this organization has no credits" can say why.
     */
    freeStartEligibility: protectedProcedure.query(({ ctx: { db, user } }) =>
        resolveFreeStartEligibility(db, user.email),
    ),
    createCheckoutSession: writeProcedure
        .input(
            z.object({
                type: z.enum([BILLING_CHECKOUT_TYPES.SUBSCRIPTION, BILLING_CHECKOUT_TYPES.TOPUP]),
                returnPath: z.string().max(500).optional(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.billing.createCheckoutSession(organizationId, input.type, input.returnPath),
        ),
    createPortalSession: writeProcedure
        .input(
            z.object({
                returnPath: z.string().max(500).optional(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.billing.createPortalSession(organizationId, input.returnPath),
        ),
    updateAutoTopUp: writeProcedure
        .input(
            z.object({
                enabled: z.boolean(),
                threshold: z.number().int().min(0),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.billing.updateAutoTopUp(organizationId, input.enabled, input.threshold),
        ),
    redeemPromoCode: writeProcedure
        .input(
            z.object({
                code: z.string().min(1).max(64),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.billing.redeemPromoCode(organizationId, input.code),
        ),
    getVercelOverageStatus: protectedProcedure.query(({ ctx: { services, organizationId } }) =>
        services.billing.getVercelOverageStatus(organizationId),
    ),
    updateVercelOverageCap: writeProcedure
        .input(
            z.object({
                maxOverageAmountUsd: z.number().positive().max(100_000).optional(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.billing.updateVercelOverageCap(organizationId, input.maxOverageAmountUsd),
        ),
});

export const billingRouter: typeof billingRouterImpl = billingRouterImpl;
