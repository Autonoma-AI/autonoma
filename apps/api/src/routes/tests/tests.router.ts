import { z } from "zod";
import { internalProcedure, protectedProcedure, router } from "../../trpc";

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

    rename: internalProcedure
        .input(z.object({ testId: z.string(), name: z.string().min(1) }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.tests.renameTest(input.testId, input.name, organizationId),
        ),

    delete: internalProcedure
        .input(z.object({ testId: z.string(), branchId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.tests.deleteTest({ testCaseId: input.testId, branchId: input.branchId, organizationId }),
        ),
});
