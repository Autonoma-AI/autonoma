import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

export const snapshotEditRouter = router({
    start: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.startEditSession(input.branchId, organizationId),
        ),

    get: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.getEditSession(input.branchId, organizationId),
        ),

    addTest: protectedProcedure
        .input(
            z.object({
                branchId: z.string(),
                name: z.string().min(1),
                plan: z.string().min(1),
                folderId: z.string(),
                description: z
                    .string()
                    .min(
                        20,
                        "State what the test does - a falsifiable behavioral claim, not the steps - in at least 20 characters.",
                    ),
                scenarioId: z.string().optional(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input: { branchId, ...rest } }) =>
            services.snapshotEdit.addTest(branchId, rest, organizationId),
        ),

    addTests: protectedProcedure
        .input(
            z.object({
                branchId: z.string(),
                tests: z
                    .array(
                        z.object({
                            name: z.string().min(1),
                            plan: z.string().min(1),
                            folderId: z.string(),
                            description: z.string().optional(),
                        }),
                    )
                    .min(1),
                scenarioId: z.string().optional(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input: { branchId, ...rest } }) =>
            services.snapshotEdit.addTests(branchId, rest, organizationId),
        ),

    updateTest: protectedProcedure
        .input(
            z.object({
                branchId: z.string(),
                testCaseId: z.string(),
                plan: z.string().min(1),
                scenarioId: z.string().optional(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input: { branchId, ...rest } }) =>
            services.snapshotEdit.updateTest(branchId, rest, organizationId),
        ),

    regenerateSteps: protectedProcedure
        .input(z.object({ branchId: z.string(), testCaseId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.regenerateSteps(input.branchId, input.testCaseId, organizationId),
        ),

    removeTest: protectedProcedure
        .input(z.object({ branchId: z.string(), testCaseId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.removeTest(input.branchId, input.testCaseId, organizationId),
        ),

    discardChange: protectedProcedure
        .input(z.object({ branchId: z.string(), testCaseId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.discardChange(input.branchId, input.testCaseId, organizationId),
        ),

    discardGeneration: protectedProcedure
        .input(z.object({ branchId: z.string(), generationId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.discardGeneration(input.branchId, input.generationId, organizationId),
        ),

    queueGenerations: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.queueGenerations(input.branchId, organizationId),
        ),

    finalize: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.finalize(input.branchId, organizationId),
        ),

    discard: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.discard(input.branchId, organizationId),
        ),
});
