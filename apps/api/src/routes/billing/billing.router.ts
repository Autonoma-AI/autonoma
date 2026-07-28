import { BILLING_CHECKOUT_TYPES } from "@autonoma/types";
import { z } from "zod";
import { protectedProcedure, writeProcedure, router } from "../../trpc";

const billingRouterImpl = router({
    status: protectedProcedure.query(({ ctx: { services, organizationId } }) =>
        services.billing.getBillingStatus(organizationId),
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
});

export const billingRouter: typeof billingRouterImpl = billingRouterImpl;
