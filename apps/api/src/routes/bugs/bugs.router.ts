import { bugVerdictSchema } from "@autonoma/types";
import { z } from "zod";
import { internalProcedure, protectedProcedure, router } from "../../trpc";

export const bugsRouter = router({
    list: protectedProcedure
        .input(
            z
                .object({
                    applicationId: z.string().optional(),
                    status: z.enum(["open", "resolved", "regressed"]).optional(),
                })
                .optional(),
        )
        .query(({ ctx: { services, organizationId }, input }) =>
            services.bugs.listBugs(organizationId, input?.applicationId, input?.status),
        ),

    listByPr: protectedProcedure
        .input(
            z.object({
                applicationId: z.string(),
                branchId: z.string(),
                status: z.enum(["open", "resolved", "regressed"]).default("open"),
                snapshotId: z.string().optional(),
            }),
        )
        .query(({ ctx: { services, organizationId }, input }) => {
            const params = {
                organizationId,
                applicationId: input.applicationId,
                branchId: input.branchId,
                status: input.status,
            };
            if (input.snapshotId != null)
                return services.bugs.listBugsByPr({ ...params, snapshotId: input.snapshotId });
            return services.bugs.listBugsByPr(params);
        }),

    detail: protectedProcedure
        .input(z.object({ bugId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.bugs.getBugDetail(input.bugId, organizationId),
        ),

    dismissIssue: protectedProcedure
        .input(z.object({ issueId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.bugs.dismissIssue(input.issueId, organizationId),
        ),

    resolve: protectedProcedure
        .input(z.object({ bugId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.bugs.resolveBug(input.bugId, organizationId),
        ),

    reopen: protectedProcedure
        .input(z.object({ bugId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.bugs.reopenBug(input.bugId, organizationId),
        ),

    classificationEnabled: internalProcedure.query(({ ctx: { services } }) => ({
        enabled: services.bugs.isClassificationEnabled(),
    })),

    classify: internalProcedure
        .input(z.object({ bugId: z.string(), verdict: bugVerdictSchema }))
        .mutation(({ ctx: { services, organizationId, user }, input }) =>
            services.bugs.classifyBug(input.bugId, organizationId, user.id, input.verdict),
        ),
});
