import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

export const runsRouter = router({
    list: protectedProcedure
        .input(z.object({ applicationId: z.string().optional(), snapshotId: z.string().optional() }).optional())
        .query(({ ctx: { services, organizationId }, input }) =>
            services.runs.listRuns(organizationId, input?.applicationId, input?.snapshotId),
        ),

    listForTestCase: protectedProcedure
        .input(z.object({ testCaseId: z.string(), limit: z.number().int().positive().max(50).default(10) }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.runs.listRunsForTestCase(input.testCaseId, organizationId, input.limit),
        ),

    detail: protectedProcedure
        .input(z.object({ runId: z.string() }))
        .query(({ ctx: { services, organizationId, user }, input }) =>
            services.runs.getRunDetail(input.runId, organizationId, user.role === "admin"),
        ),

    remove: protectedProcedure
        .input(z.object({ runId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.runs.deleteRun(input.runId, organizationId),
        ),
});
