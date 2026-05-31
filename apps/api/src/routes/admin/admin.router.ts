import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { env } from "../../env";
import { publicProcedure, router } from "../../trpc";

const adminProcedure = publicProcedure.use(async ({ ctx, next }) => {
    if (ctx.user == null || ctx.session == null) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    if (ctx.user.role !== "admin") {
        throw new TRPCError({
            code: "FORBIDDEN",
            message: "Admin access required",
        });
    }
    return next({ ctx: { ...ctx, user: ctx.user, session: ctx.session } });
});

export const adminRouter = router({
    /**
     * Returns deployment-level config admins use to deep-link into observability
     * tools (Sentry logs explorer, etc.). Admin-only because the namespace value
     * is internal deployment metadata; not meant for end-user UI.
     */
    deploymentConfig: adminProcedure.query(() => ({
        environment: env.SENTRY_ENV,
    })),
    listOrganizations: adminProcedure.query(({ ctx: { services } }) => services.admin.listOrganizations()),
    listPendingOrgs: adminProcedure.query(({ ctx: { services } }) => services.admin.listPendingOrgs()),
    approveOrg: adminProcedure
        .input(z.object({ orgId: z.string() }))
        .mutation(({ ctx: { services }, input }) => services.admin.approveOrg(input.orgId)),
    rejectOrg: adminProcedure
        .input(z.object({ orgId: z.string() }))
        .mutation(({ ctx: { services }, input }) => services.admin.rejectOrg(input.orgId)),
    createOrg: adminProcedure
        .input(z.object({ name: z.string().min(1), slug: z.string().min(1), domain: z.string().min(1) }))
        .mutation(({ ctx: { services }, input }) => services.admin.createOrg(input.name, input.slug, input.domain)),
    switchToOrg: adminProcedure
        .input(z.object({ orgId: z.string() }))
        .mutation(({ ctx, input }) => ctx.services.admin.switchToOrg(ctx.user.id, ctx.session.token, input.orgId)),
    github: router({
        listRepositories: adminProcedure.query(({ ctx: { services } }) => services.admin.listGitHubRepositories()),
        getRepositoryArchiveUrl: adminProcedure
            .input(
                z.object({
                    installationId: z.number().int().positive(),
                    repositoryId: z.number().int().positive(),
                    ref: z.string().trim().min(1).optional(),
                }),
            )
            .mutation(({ ctx: { services }, input }) => services.admin.getGitHubRepositoryArchiveUrl(input)),
    }),
    billing: router({
        listPromoCodes: adminProcedure
            .input(
                z
                    .object({
                        page: z.number().int().min(1).optional(),
                        pageSize: z.number().int().min(1).max(100).optional(),
                        query: z.string().optional(),
                        isActive: z.boolean().optional(),
                    })
                    .optional(),
            )
            .query(({ ctx: { services }, input }) => services.billing.listPromoCodes(input)),
        createPromoCode: adminProcedure
            .input(
                z.object({
                    code: z.string().min(1).max(64),
                    description: z.string().max(200).optional().nullable(),
                    grantCredits: z.number().int().positive(),
                    maxRedemptions: z.number().int().positive().optional().nullable(),
                    endsAt: z.date().optional().nullable(),
                }),
            )
            .mutation(({ ctx: { services }, input }) => services.billing.createPromoCode(input)),
        setPromoCodeActive: adminProcedure
            .input(
                z.object({
                    promoCodeId: z.string().min(1),
                    isActive: z.boolean(),
                }),
            )
            .mutation(({ ctx: { services }, input }) =>
                services.billing.setPromoCodeActive(input.promoCodeId, input.isActive),
            ),
    }),
});
