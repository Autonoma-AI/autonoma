import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

const issueKindSchema = z.enum(["application_bug", "engine_limitation", "unknown_issue"]);

export const issuesRouter = router({
    list: protectedProcedure
        .input(
            z
                .object({
                    applicationId: z.string().optional(),
                    kind: issueKindSchema.optional(),
                })
                .optional(),
        )
        .query(({ ctx: { services, organizationId }, input }) =>
            services.issues.listIssues(organizationId, { applicationId: input?.applicationId, kind: input?.kind }),
        ),

    detail: protectedProcedure
        .input(z.object({ issueId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.issues.getIssueDetail(input.issueId, organizationId),
        ),
});
