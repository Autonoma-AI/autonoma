import {
    DeleteSecretInputSchema,
    DiagnosePreviewkitDeployInputSchema,
    IntrospectRepositoryInputSchema,
    ListSecretsInputSchema,
    PreviewkitConfigSecretsSchema,
    SuggestEnvVarsInputSchema,
    SuggestServicesInputSchema,
    UpsertSecretsInputSchema,
    previewConfigSchema,
} from "@autonoma/types";
import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

const applicationIdInput = z.object({ applicationId: z.string() });
const previewEnvironmentModeInput = z.enum(["previewkit", "existing_deploys"]);

export const onboardingRouter = router({
    getState: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) => ctx.services.onboarding.getState(input.applicationId)),

    getLogs: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) => ctx.services.onboarding.getLogs(input.applicationId)),

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

    prepareSdkTarget: protectedProcedure
        .input(z.object({ applicationId: z.string(), targetId: z.string() }))
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.prepareSdkTarget(input.applicationId, ctx.organizationId, input.targetId),
        ),

    configureAndDiscoverSdkTarget: protectedProcedure
        .input(
            z.object({
                applicationId: z.string(),
                targetId: z.string(),
                // Bounded fallback for legacy previews: the UI sends true only on
                // the user's first click and false on its single auto-retry, so a
                // 401 that survives one redeploy surfaces instead of looping.
                allowSelfHeal: z.boolean().default(false),
            }),
        )
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.configureAndDiscoverSdkTarget(
                input.applicationId,
                ctx.organizationId,
                input.targetId,
                input.allowSelfHeal,
            ),
        ),

    runScenarioDryRun: protectedProcedure
        .input(z.object({ applicationId: z.string(), scenarioId: z.string(), targetId: z.string().optional() }))
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.runScenarioDryRun(
                input.applicationId,
                ctx.organizationId,
                input.scenarioId,
                input.targetId,
            ),
        ),

    listSdkDryRunTargets: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.listSdkDryRunTargets(input.applicationId, ctx.organizationId),
        ),

    completeGithub: protectedProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) => ctx.services.onboarding.completeGithub(input.applicationId, ctx.organizationId)),

    selectPreviewEnvironmentMode: protectedProcedure
        .input(z.object({ applicationId: z.string(), mode: previewEnvironmentModeInput }))
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.selectPreviewEnvironmentMode(input.applicationId, ctx.organizationId, input.mode),
        ),

    confirmExistingDeploysSetup: protectedProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.confirmExistingDeploysSetup(input.applicationId, ctx.organizationId),
        ),

    getPreviewkitConfig: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.getPreviewkitConfig(input.applicationId, ctx.organizationId),
        ),

    savePreviewkitConfig: protectedProcedure
        .input(
            z.object({
                applicationId: z.string(),
                document: previewConfigSchema,
                dependencyDocuments: z.array(z.object({ repo: z.string(), document: previewConfigSchema })).optional(),
                secrets: PreviewkitConfigSecretsSchema.optional(),
            }),
        )
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.savePreviewkitConfig(
                input.applicationId,
                ctx.organizationId,
                input.document,
                input.dependencyDocuments,
                input.secrets,
            ),
        ),

    getDeploymentSignalStatus: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.getDeploymentSignalStatus(input.applicationId, ctx.organizationId),
        ),

    introspectRepository: protectedProcedure
        .input(IntrospectRepositoryInputSchema)
        .query(({ ctx, input }) =>
            ctx.services.repoIntrospection.introspect(
                ctx.organizationId,
                input.applicationId,
                input.githubRepositoryId,
            ),
        ),

    suggestPreviewkitServices: protectedProcedure
        .input(SuggestServicesInputSchema)
        .query(({ ctx, input }) => ctx.services.previewkitSuggestions.suggestServices(ctx.organizationId, input)),

    suggestPreviewkitEnvVars: protectedProcedure
        .input(SuggestEnvVarsInputSchema)
        .query(({ ctx, input }) => ctx.services.previewkitSuggestions.suggestEnvVars(ctx.organizationId, input)),

    diagnosePreviewkitDeploy: protectedProcedure
        .input(DiagnosePreviewkitDeployInputSchema)
        .query(({ ctx, input }) => ctx.services.previewkitDiagnosis.diagnose(ctx.organizationId, input)),

    validatePreviewkitConfig: protectedProcedure
        // `document` is deliberately unvalidated at the boundary: this procedure's
        // job is to report problems with malformed documents as data, not 400.
        .input(
            z.object({
                applicationId: z.string(),
                document: z.unknown(),
                githubRepositoryId: z.number().int().positive().optional(),
            }),
        )
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.validatePreviewkitConfig(
                input.applicationId,
                ctx.organizationId,
                input.document,
                input.githubRepositoryId,
            ),
        ),

    listPreviewkitSecrets: protectedProcedure
        .input(ListSecretsInputSchema)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.listPreviewkitSecrets(input.applicationId, ctx.organizationId, input.appName),
        ),

    upsertPreviewkitSecrets: protectedProcedure
        .input(UpsertSecretsInputSchema)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.upsertPreviewkitSecrets(
                input.applicationId,
                ctx.organizationId,
                input.appName,
                input.items,
            ),
        ),

    deletePreviewkitSecret: protectedProcedure
        .input(DeleteSecretInputSchema)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.deletePreviewkitSecret(
                input.applicationId,
                ctx.organizationId,
                input.appName,
                input.key,
            ),
        ),

    triggerPreviewkitMainDeploy: protectedProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.triggerPreviewkitMainDeploy(input.applicationId, ctx.organizationId),
        ),

    getPreviewReadiness: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.getPreviewReadiness(input.applicationId, ctx.organizationId),
        ),

    completePreviewOnboarding: protectedProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.completePreviewOnboarding(input.applicationId, ctx.organizationId),
        ),

    goLive: protectedProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) => ctx.services.onboarding.goLive(input.applicationId, ctx.organizationId)),
});
