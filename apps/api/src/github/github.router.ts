import { z } from "zod";
import { protectedProcedure, router } from "../trpc";
import { createInstallState } from "./github-state";

export const githubRouter = router({
    getConfig: protectedProcedure.input(z.object({ returnPath: z.string().optional() })).query(
        ({
            ctx: {
                organizationId,
                services: { github },
            },
            input,
        }) => {
            const slug = github.getSlug();

            const state = createInstallState(organizationId, input.returnPath);
            return {
                installUrl: `https://github.com/apps/${slug}/installations/new?state=${state}`,
            };
        },
    ),

    getInstallation: protectedProcedure.query(async ({ ctx: { services, organizationId } }) => {
        const installation = await services.github.getInstallation(organizationId);
        if (installation == null) return null;

        const slug = services.github.getSlug();
        const settingsUrl = `https://github.com/apps/${slug}/installations/new`;

        return { ...installation, settingsUrl, appSlug: slug };
    }),

    listRepositories: protectedProcedure.query(({ ctx: { services, organizationId } }) =>
        services.github.listRepositories(organizationId),
    ),

    linkRepository: protectedProcedure
        .input(
            z.object({
                applicationId: z.string(),
                githubRepoId: z.number(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.github.linkRepository(organizationId, input.applicationId, input.githubRepoId),
        ),

    disconnect: protectedProcedure.mutation(({ ctx: { services, organizationId } }) =>
        services.github.disconnect(organizationId),
    ),

    getPullRequest: protectedProcedure
        .input(z.object({ applicationId: z.string(), prNumber: z.number().int().positive() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.github.getApplicationPullRequest(organizationId, input.applicationId, input.prNumber),
        ),

    getCommit: protectedProcedure
        .input(z.object({ applicationId: z.string(), sha: z.string().trim().min(1) }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.github.getApplicationCommit(organizationId, input.applicationId, input.sha),
        ),
});
