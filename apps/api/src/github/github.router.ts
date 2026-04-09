import { GitHubDeploymentTriggerSchema } from "@autonoma/types";
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

    updateRepoConfig: protectedProcedure
        .input(
            z.object({
                repoId: z.string(),
                watchBranch: z.string().min(1),
                deploymentTrigger: GitHubDeploymentTriggerSchema,
                applicationId: z.string().optional(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.github.updateRepoConfig(
                organizationId,
                input.repoId,
                input.watchBranch,
                input.deploymentTrigger,
                input.applicationId,
            ),
        ),

    disconnect: protectedProcedure.mutation(({ ctx: { services, organizationId } }) =>
        services.github.disconnect(organizationId),
    ),

    getTestCases: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.github.getTestCases(organizationId, input.applicationId),
        ),

    deploymentsDebug: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.github.listDeploymentsDebug(organizationId, input.applicationId),
        ),
});
