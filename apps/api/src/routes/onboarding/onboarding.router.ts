import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

const applicationIdInput = z.object({ applicationId: z.string() });

export const onboardingRouter = router({
    getState: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) => ctx.services.onboarding.getState(input.applicationId)),

    getLogs: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) => ctx.services.onboarding.getLogs(input.applicationId)),

    startConfigure: protectedProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) => ctx.services.onboarding.startConfigure(input.applicationId)),

    startScenarioDryRun: protectedProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) => ctx.services.onboarding.startScenarioDryRun(input.applicationId)),

    setUrl: protectedProcedure
        .input(z.object({ applicationId: z.string(), productionUrl: z.string().url() }))
        .mutation(({ ctx, input }) => ctx.services.onboarding.setUrl(input.applicationId, input.productionUrl)),

    configureAndDiscoverScenarios: protectedProcedure
        .input(
            z.object({
                applicationId: z.string(),
                webhookUrl: z.string().url(),
                signingSecret: z.string(),
                webhookHeaders: z.record(z.string(), z.string()).optional(),
            }),
        )
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.configureAndDiscoverScenarios(
                input.applicationId,
                ctx.organizationId,
                input.webhookUrl,
                input.signingSecret,
                input.webhookHeaders,
            ),
        ),

    runScenarioDryRun: protectedProcedure
        .input(z.object({ applicationId: z.string(), scenarioId: z.string() }))
        .mutation(({ ctx, input }) => ctx.services.onboarding.runScenarioDryRun(input.applicationId, input.scenarioId)),

    complete: protectedProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) => ctx.services.onboarding.complete(input.applicationId)),

    completeGithub: protectedProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) => ctx.services.onboarding.completeGithub(input.applicationId, ctx.organizationId)),

    reset: protectedProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) => ctx.services.onboarding.reset(input.applicationId)),
});
