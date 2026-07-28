import { bugVerdictSchema } from "@autonoma/types";
import { z } from "zod";
import { internalProcedure, protectedProcedure, writeProcedure, router } from "../../trpc";

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

    listSummary: protectedProcedure
        .input(
            z
                .object({
                    applicationId: z.string().optional(),
                    status: z.enum(["open", "resolved", "regressed"]).optional(),
                })
                .optional(),
        )
        .query(({ ctx: { services, organizationId }, input }) =>
            services.bugs.listBugsSummary(organizationId, input?.applicationId, input?.status),
        ),

    listByBranch: protectedProcedure
        .input(
            z.object({
                branchId: z.string(),
                status: z.enum(["open", "resolved", "regressed"]).default("open"),
            }),
        )
        .query(({ ctx: { services, organizationId }, input }) =>
            services.bugs.listBugsByBranch({
                organizationId,
                branchId: input.branchId,
                status: input.status,
            }),
        ),

    detail: protectedProcedure
        .input(z.object({ bugId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.bugs.getBugDetail(input.bugId, organizationId),
        ),

    dismissIssue: writeProcedure
        .input(z.object({ issueId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.bugs.dismissIssue(input.issueId, organizationId),
        ),

    resolve: writeProcedure
        .input(z.object({ bugId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.bugs.resolveBug(input.bugId, organizationId),
        ),

    reopen: writeProcedure
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
