import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

export const deploymentsRouter = router({
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
});
