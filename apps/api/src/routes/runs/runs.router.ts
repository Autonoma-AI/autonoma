import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

export const runsRouter = router({
    trigger: protectedProcedure
        .input(z.object({ testCaseId: z.string(), snapshotId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.runs.triggerRun(input.testCaseId, input.snapshotId, organizationId),
        ),

    list: protectedProcedure
        .input(z.object({ applicationId: z.string().optional(), snapshotId: z.string().optional() }).optional())
        .query(({ ctx: { services, organizationId }, input }) =>
            services.runs.listRuns(organizationId, input?.applicationId, input?.snapshotId),
        ),

    detail: protectedProcedure
        .input(z.object({ runId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.runs.getRunDetail(input.runId, organizationId),
        ),

    restart: protectedProcedure
        .input(z.object({ runId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.runs.restartRun(input.runId, organizationId),
        ),

    remove: protectedProcedure
        .input(z.object({ runId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.runs.deleteRun(input.runId, organizationId),
        ),
});
