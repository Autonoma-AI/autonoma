import { z } from "zod";
import { protectedProcedure, writeProcedure, router } from "../../trpc";

const testBySlugInput = z.object({ applicationId: z.string(), slug: z.string() });

export const testsRouter = router({
    list: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.tests.getTestCases(input.applicationId, organizationId),
        ),

    detail: protectedProcedure
        .input(testBySlugInput.extend({ snapshotId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.tests.getTestDetail(input.applicationId, input.slug, input.snapshotId, organizationId),
        ),

    rename: writeProcedure
        .input(z.object({ testId: z.string(), name: z.string().min(1) }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.tests.renameTest(input.testId, input.name, organizationId),
        ),

    delete: writeProcedure
        .input(z.object({ testId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.tests.deleteTest(input.testId, organizationId),
        ),
});
