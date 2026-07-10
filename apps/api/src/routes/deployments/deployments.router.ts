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
});
