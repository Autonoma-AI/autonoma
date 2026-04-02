import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

export const notificationsRouter = router({
    configureSlack: protectedProcedure
        .input(
            z.object({
                applicationId: z.string(),
                slackWebhookUrl: z.string().url(),
            }),
        )
        .mutation(({ ctx, input }) =>
            ctx.services.notifications.configureSlack(input.applicationId, ctx.organizationId, input.slackWebhookUrl),
        ),

    removeSlack: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .mutation(({ ctx, input }) => ctx.services.notifications.removeSlack(input.applicationId, ctx.organizationId)),

    getConfig: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx, input }) => ctx.services.notifications.getConfig(input.applicationId, ctx.organizationId)),

    testSlack: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .mutation(({ ctx, input }) => ctx.services.notifications.testSlack(input.applicationId, ctx.organizationId)),
});
