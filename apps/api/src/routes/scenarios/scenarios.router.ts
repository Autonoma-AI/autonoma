import {
    ConfigureWebhookInputSchema,
    DiscoverInputSchema,
    DryRunInputSchema,
    GetRecipeInputSchema,
    ListInstancesInputSchema,
    ListScenariosInputSchema,
    ListWebhookCallsInputSchema,
    RemoveWebhookInputSchema,
    UpdateRecipeInputSchema,
} from "@autonoma/types";
import { internalProcedure, protectedProcedure, router } from "../../trpc";

export const scenariosRouter = router({
    configureWebhook: protectedProcedure
        .input(ConfigureWebhookInputSchema)
        .mutation(({ ctx, input }) =>
            ctx.services.scenarios.configureWebhook(
                input.applicationId,
                input.deploymentId,
                ctx.organizationId,
                input.webhookUrl,
                input.webhookHeaders,
            ),
        ),

    removeWebhook: protectedProcedure
        .input(RemoveWebhookInputSchema)
        .mutation(({ ctx, input }) =>
            ctx.services.scenarios.removeWebhook(input.applicationId, input.deploymentId, ctx.organizationId),
        ),

    discover: protectedProcedure
        .input(DiscoverInputSchema)
        .mutation(({ ctx, input }) =>
            ctx.services.scenarios.discover(input.applicationId, input.deploymentId, ctx.organizationId),
        ),

    list: protectedProcedure
        .input(ListScenariosInputSchema)
        .query(({ ctx, input }) => ctx.services.scenarios.listScenarios(input.applicationId, ctx.organizationId)),

    listInstances: protectedProcedure
        .input(ListInstancesInputSchema)
        .query(({ ctx, input }) => ctx.services.scenarios.listInstances(input.scenarioId, ctx.organizationId)),

    listWebhookCalls: protectedProcedure
        .input(ListWebhookCallsInputSchema)
        .query(({ ctx, input }) => ctx.services.scenarios.listWebhookCalls(input.applicationId, ctx.organizationId)),

    dryRun: protectedProcedure
        .input(DryRunInputSchema)
        .mutation(({ ctx, input }) =>
            ctx.services.scenarios.dryRun(input.applicationId, ctx.organizationId, input.scenarioId),
        ),

    getRecipe: internalProcedure
        .input(GetRecipeInputSchema)
        .query(({ ctx, input }) => ctx.services.scenarios.getRecipe(input.scenarioId, ctx.organizationId)),

    updateRecipe: internalProcedure
        .input(UpdateRecipeInputSchema)
        .mutation(({ ctx, input }) =>
            ctx.services.scenarios.updateRecipe(input.scenarioId, input.fixtureJson, ctx.organizationId),
        ),
});
