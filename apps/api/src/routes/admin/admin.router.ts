import { z } from "zod";
import { env } from "../../env";
import { internalProcedure, router } from "../../trpc";

export const adminRouter = router({
    /**
     * Returns deployment-level config admins use to deep-link into observability
     * tools (Sentry logs explorer, etc.). Admin-only because the namespace value
     * is internal deployment metadata; not meant for end-user UI.
     */
    deploymentConfig: internalProcedure.query(() => ({
        environment: env.SENTRY_ENV,
    })),
    /**
     * Active Previewkit environments across all organizations, with their URLs.
     * Admin-gated operational view. Delegates to the deployments service, which
     * owns Previewkit environment queries.
     */
    listPreviewkitEnvironments: internalProcedure.query(({ ctx: { services } }) =>
        services.deployments.listActiveEnvironments(),
    ),
    /**
     * Re-runs the Previewkit pipeline for a preview environment (all apps, at
     * the PR's current head SHA). Admin-gated; delegates to the deployments
     * service, which calls Previewkit's redeploy endpoint.
     */
    redeployPreviewkitEnvironment: internalProcedure
        .input(z.object({ environmentId: z.string().min(1) }))
        .mutation(({ ctx: { services }, input }) => services.deployments.redeployEnvironment(input.environmentId)),
    /**
     * Applications eligible for a main-branch preview deploy (linked to a GitHub
     * repository, owned by an org with an active installation). Admin-gated;
     * the picker source for the deploy action below.
     */
    listPreviewkitDeployableApplications: internalProcedure.query(({ ctx: { services } }) =>
        services.deployments.listDeployableApplications(),
    ),
    /**
     * Deploys an Application's main branch into preview environment 0. Admin-gated;
     * delegates to the deployments service, which starts the deploy workflow (or
     * forwards to Previewkit's main-branch endpoint on the legacy path).
     */
    deployPreviewkitMainBranch: internalProcedure
        .input(z.object({ applicationId: z.string().min(1) }))
        .mutation(({ ctx: { services }, input }) => services.deployments.deployMainBranch(input.applicationId)),
    listOrganizations: internalProcedure.query(({ ctx: { services } }) => services.admin.listOrganizations()),
    listPendingOrgs: internalProcedure.query(({ ctx: { services } }) => services.admin.listPendingOrgs()),
    approveOrg: internalProcedure
        .input(z.object({ orgId: z.string() }))
        .mutation(({ ctx: { services }, input }) => services.admin.approveOrg(input.orgId)),
    rejectOrg: internalProcedure
        .input(z.object({ orgId: z.string() }))
        .mutation(({ ctx: { services }, input }) => services.admin.rejectOrg(input.orgId)),
    createOrg: internalProcedure
        .input(z.object({ name: z.string().min(1), slug: z.string().min(1), domain: z.string().min(1) }))
        .mutation(({ ctx: { services }, input }) => services.admin.createOrg(input.name, input.slug, input.domain)),
    switchToOrg: internalProcedure
        .input(z.object({ orgId: z.string() }))
        .mutation(({ ctx, input }) => ctx.services.admin.switchToOrg(ctx.user.id, ctx.session.token, input.orgId)),
    // Internal-user navigation aid: resolves which org owns an app slug so a
    // shared cross-org deep link can auto-switch into the right org.
    findOrgByAppSlug: internalProcedure
        .input(z.object({ appSlug: z.string().min(1) }))
        .query(({ ctx: { services }, input }) => services.admin.findOrgByAppSlug(input.appSlug)),
    github: router({
        listRepositories: internalProcedure.query(({ ctx: { services } }) => services.admin.listGitHubRepositories()),
        getRepositoryArchiveUrl: internalProcedure
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
        listPromoCodes: internalProcedure
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
        createPromoCode: internalProcedure
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
        setPromoCodeActive: internalProcedure
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
