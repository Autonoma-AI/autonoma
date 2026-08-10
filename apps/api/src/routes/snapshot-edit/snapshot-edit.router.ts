import { z } from "zod";
import { protectedProcedure, writeProcedure, router } from "../../trpc";

// 20-char floor matches the CLI generator; a higher floor would reject conformant CLI output.
const descriptionSchema = z
    .string()
    .min(20, "State what the test does - a falsifiable behavioral claim, not the steps - in at least 20 characters.");

export const snapshotEditRouter = router({
    state: protectedProcedure
        .input(z.object({ branchId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.getState(input.branchId, organizationId),
        ),

    start: writeProcedure
        .input(z.object({ branchId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.startEditSession(input.branchId, organizationId),
        ),

    get: protectedProcedure
        .input(z.object({ snapshotId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.getEditSession(input.snapshotId, organizationId),
        ),

    addTest: writeProcedure
        .input(
            z.object({
                snapshotId: z.string(),
                name: z.string().min(1),
                plan: z.string().min(1),
                folderId: z.string(),
                description: descriptionSchema,
                scenarioId: z.string().optional(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input: { snapshotId, ...rest } }) =>
            services.snapshotEdit.addTest(snapshotId, rest, organizationId),
        ),

    addTests: writeProcedure
        .input(
            z.object({
                snapshotId: z.string(),
                tests: z
                    .array(
                        z.object({
                            name: z.string().min(1),
                            plan: z.string().min(1),
                            folderId: z.string(),
                            description: descriptionSchema,
                        }),
                    )
                    .min(1),
                scenarioId: z.string().optional(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input: { snapshotId, ...rest } }) =>
            services.snapshotEdit.addTests(snapshotId, rest, organizationId),
        ),

    updateTest: writeProcedure
        .input(
            z.object({
                snapshotId: z.string(),
                testCaseId: z.string(),
                plan: z.string().min(1),
                scenarioId: z.string().optional(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input: { snapshotId, ...rest } }) =>
            services.snapshotEdit.updateTest(snapshotId, rest, organizationId),
        ),

    removeTest: writeProcedure
        .input(z.object({ snapshotId: z.string(), testCaseId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.removeTest(input.snapshotId, input.testCaseId, organizationId),
        ),

    discardChange: writeProcedure
        .input(z.object({ snapshotId: z.string(), testCaseId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.discardChange(input.snapshotId, input.testCaseId, organizationId),
        ),

    startRuns: writeProcedure
        .input(z.object({ snapshotId: z.string(), testCaseIds: z.array(z.string()).min(1) }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.startRuns(input.snapshotId, input.testCaseIds, organizationId),
        ),

    finalize: writeProcedure
        .input(z.object({ snapshotId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.finalize(input.snapshotId, organizationId),
        ),

    discard: writeProcedure
        .input(z.object({ snapshotId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.snapshotEdit.discard(input.snapshotId, organizationId),
        ),
});
