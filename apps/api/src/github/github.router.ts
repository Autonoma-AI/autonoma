import { TriggerConfigSchema } from "@autonoma/types";
import { z } from "zod";
import { protectedProcedure, writeProcedure, router } from "../trpc";
import { createInstallState } from "./github-state";
import { configureInstallationUrl } from "./github-urls";

export const githubRouter = router({
    getConfig: protectedProcedure.input(z.object({ returnPath: z.string().optional() })).query(
        async ({
            ctx: {
                organizationId,
                services: { github },
            },
            input,
        }) => {
            const slug = github.getSlug();

            const state = await createInstallState(organizationId, input.returnPath);
            return {
                installUrl: `https://github.com/apps/${slug}/installations/new?state=${state}`,
            };
        },
    ),

    getInstallation: protectedProcedure.query(async ({ ctx: { services, organizationId } }) => {
        const installation = await services.github.getInstallation(organizationId);
        if (installation == null) return null;
        // A `deleted` row is a tombstone: GitHub told us the app is gone from that account, so
        // there is nothing left to configure or manage. Returning it made every surface offer a
        // "Configure GitHub App" button pointing at an installation that no longer exists - a 404
        // for someone whose actual intent was to install fresh. Absent is the honest answer, and
        // it puts them on the install path, which `handleInstallation` adopts the tombstone for.
        // `suspended` is deliberately still returned: that installation exists and comes back.
        if (installation.status === "deleted") return null;
        // A row can also be stale WITHOUT being marked deleted - an uninstall whose webhook never
        // arrived, or a database restored from another environment, whose rows name installations
        // of a different GitHub App. The listing is what proves it: if GitHub will not say what
        // this installation can see, there is nothing here to manage, and every link we would
        // render for it points at an installation that does not exist for this app.
        const listing = await services.github.listRepositories(organizationId);
        if (listing.unavailable != null) return null;

        const slug = services.github.getSlug();

        return {
            ...installation,
            settingsUrl: configureInstallationUrl(installation.installationId, {
                login: installation.accountLogin,
                type: installation.accountType,
            }),
            appSlug: slug,
        };
    }),

    listRepositories: protectedProcedure.query(({ ctx: { services, organizationId } }) =>
        services.github.listRepositories(organizationId),
    ),

    getApplicationRepository: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.github.getApplicationRepository(organizationId, input.applicationId),
        ),

    linkRepository: writeProcedure
        .input(
            z.object({
                applicationId: z.string(),
                githubRepoId: z.number(),
            }),
        )
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.github.linkRepository(organizationId, input.applicationId, input.githubRepoId),
        ),

    unlinkRepository: writeProcedure
        .input(z.object({ applicationId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.github.unlinkRepository(organizationId, input.applicationId),
        ),

    disconnect: writeProcedure.mutation(({ ctx: { services, organizationId } }) =>
        services.github.disconnect(organizationId),
    ),

    getPullRequest: protectedProcedure
        .input(z.object({ applicationId: z.string(), prNumber: z.number().int().positive() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.github.getApplicationPullRequest(organizationId, input.applicationId, input.prNumber),
        ),

    listPullRequestCommits: protectedProcedure
        .input(z.object({ applicationId: z.string(), prNumber: z.number().int().positive() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.github.listApplicationPullRequestCommits(organizationId, input.applicationId, input.prNumber),
        ),

    getCommit: protectedProcedure
        .input(z.object({ applicationId: z.string(), sha: z.string().trim().min(1) }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.github.getApplicationCommit(organizationId, input.applicationId, input.sha),
        ),

    getTriggerConfig: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.activationTriggerConfig.getForApplication(organizationId, input.applicationId),
        ),

    updateTriggerConfig: writeProcedure
        .input(z.object({ applicationId: z.string() }).merge(TriggerConfigSchema))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.activationTriggerConfig.updateForApplication(organizationId, input.applicationId, {
                autoRunOnReadyForReview: input.autoRunOnReadyForReview,
                analysisTriggerLabel: input.analysisTriggerLabel,
            }),
        ),

    runAnalysis: writeProcedure
        .input(z.object({ applicationId: z.string(), prNumber: z.number().int().positive() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.mergeGate.requestAnalysisRunFromApplication({
                organizationId,
                applicationId: input.applicationId,
                prNumber: input.prNumber,
            }),
        ),
});
