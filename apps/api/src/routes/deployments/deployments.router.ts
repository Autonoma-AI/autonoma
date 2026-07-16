import {
    RedeployPreviewkitAppInputSchema,
    TestUserOptionsInputSchema,
    TestUserProvisionInputSchema,
    TestUserTeardownInputSchema,
} from "@autonoma/types";
import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

export const deploymentsRouter = router({
    listActiveForApp: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.deployments.listActiveEnvironmentsForApp(input.applicationId, organizationId),
        ),
    listByPr: protectedProcedure
        .input(z.object({ applicationId: z.string(), prNumber: z.number().int().positive() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.deployments.listByPr(input.applicationId, input.prNumber, organizationId),
        ),
    previewSummaryByPr: protectedProcedure
        .input(z.object({ applicationId: z.string(), prNumber: z.number().int().positive() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.deployments.previewSummaryByPr(input.applicationId, input.prNumber, organizationId),
        ),
    previewSummaryById: protectedProcedure
        .input(z.object({ applicationId: z.string(), environmentId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.deployments.previewSummaryById(input.applicationId, input.environmentId, organizationId),
        ),
    previewSummaryByBranchId: protectedProcedure
        .input(z.object({ applicationId: z.string(), branchId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.deployments.previewSummaryByBranchId(input.applicationId, input.branchId, organizationId),
        ),
    history: protectedProcedure
        .input(z.object({ applicationId: z.string(), environmentId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.deployments.deploymentHistory(input.applicationId, input.environmentId, organizationId),
        ),
    redeployApp: protectedProcedure
        .input(RedeployPreviewkitAppInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.deployments.redeployAppForApplication(
                input.applicationId,
                input.environmentId,
                input.app,
                input.mode,
                organizationId,
            ),
        ),
    testUserOptions: protectedProcedure
        .input(TestUserOptionsInputSchema)
        .query(({ ctx: { services, organizationId }, input }) =>
            services.previewkitEnvFactory.getOptionsForApp(input.applicationId, input.environmentId, organizationId),
        ),
    testUserProvision: protectedProcedure
        .input(TestUserProvisionInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.previewkitEnvFactory.provisionForApp({ ...input, organizationId }),
        ),
    testUserTeardown: protectedProcedure
        .input(TestUserTeardownInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.previewkitEnvFactory.teardownForApp({ ...input, organizationId }),
        ),
});
