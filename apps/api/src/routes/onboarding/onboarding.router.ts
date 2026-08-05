import {
    DeleteSecretInputSchema,
    ListSecretsInputSchema,
    PreviewkitConfigSecretsSchema,
    SecretItemSchema,
    UpsertSecretsInputSchema,
    authoringPreviewConfigSchema,
} from "@autonoma/types";
import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";
import { onboardingWriteProcedure } from "./onboarding-write-procedure";

const applicationIdInput = z.object({ applicationId: z.string() });
const previewEnvironmentModeInput = z.enum(["previewkit", "existing_deploys"]);

export const onboardingRouter = router({
    getState: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) => ctx.services.onboarding.getState(input.applicationId, ctx.organizationId)),

    getLogs: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) => ctx.services.onboarding.getLogs(input.applicationId, ctx.organizationId)),

    configureAndDiscoverScenarios: onboardingWriteProcedure
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

    listAvailableVercelProjects: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.listAvailableVercelProjects(input.applicationId, ctx.organizationId),
        ),

    linkVercelProject: onboardingWriteProcedure
        .input(z.object({ applicationId: z.string(), vercelProjectId: z.string() }))
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.linkVercelProject(input.applicationId, ctx.organizationId, input.vercelProjectId),
        ),

    unlinkVercelProject: onboardingWriteProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.unlinkVercelProject(input.applicationId, ctx.organizationId),
        ),

    listVercelDeployments: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.listVercelDeployments(input.applicationId, ctx.organizationId),
        ),

    redeployVercelDeployment: onboardingWriteProcedure
        .input(z.object({ applicationId: z.string(), vercelDeploymentId: z.string() }))
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.redeployVercelDeployment(
                input.applicationId,
                ctx.organizationId,
                input.vercelDeploymentId,
            ),
        ),

    getVercelDeploymentStatus: protectedProcedure
        .input(z.object({ applicationId: z.string(), vercelDeploymentId: z.string() }))
        .query(({ ctx, input }) =>
            ctx.services.onboarding.getVercelDeploymentStatus(
                input.applicationId,
                ctx.organizationId,
                input.vercelDeploymentId,
            ),
        ),

    selectVercelDeployment: onboardingWriteProcedure
        .input(z.object({ applicationId: z.string(), vercelDeploymentId: z.string() }))
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.selectVercelDeployment(
                input.applicationId,
                ctx.organizationId,
                input.vercelDeploymentId,
            ),
        ),

    discoverVercelDeploymentTarget: onboardingWriteProcedure
        .input(
            z.object({
                applicationId: z.string(),
                vercelDeploymentId: z.string(),
                // The UI sends true on the user's first Validate click and false on
                // its single auto-retry, so a secret-drift 401 that survives one
                // redeploy surfaces instead of looping.
                allowRedeploy: z.boolean().default(false),
            }),
        )
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.discoverVercelDeploymentTarget(
                input.applicationId,
                ctx.organizationId,
                input.vercelDeploymentId,
                input.allowRedeploy,
            ),
        ),

    prepareSdkTarget: onboardingWriteProcedure
        .input(z.object({ applicationId: z.string(), targetId: z.string() }))
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.prepareSdkTarget(input.applicationId, ctx.organizationId, input.targetId),
        ),

    configureAndDiscoverSdkTarget: onboardingWriteProcedure
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

    runScenarioDryRun: onboardingWriteProcedure
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

    redeploySdkDryRunTarget: onboardingWriteProcedure
        .input(z.object({ applicationId: z.string(), targetId: z.string() }))
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.redeploySdkDryRunTarget(input.applicationId, ctx.organizationId, input.targetId),
        ),

    completeGithub: onboardingWriteProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) => ctx.services.onboarding.completeGithub(input.applicationId, ctx.organizationId)),

    selectPreviewEnvironmentMode: onboardingWriteProcedure
        .input(z.object({ applicationId: z.string(), mode: previewEnvironmentModeInput }))
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.selectPreviewEnvironmentMode(input.applicationId, ctx.organizationId, input.mode),
        ),

    confirmExistingDeploysSetup: onboardingWriteProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.confirmExistingDeploysSetup(input.applicationId, ctx.organizationId),
        ),

    getPreviewkitConfig: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.getPreviewkitConfig(input.applicationId, ctx.organizationId),
        ),

    savePreviewkitConfig: onboardingWriteProcedure
        .input(
            z.object({
                applicationId: z.string(),
                document: authoringPreviewConfigSchema,
                secrets: PreviewkitConfigSecretsSchema.optional(),
            }),
        )
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.savePreviewkitConfig(
                input.applicationId,
                ctx.organizationId,
                input.document,
                input.secrets,
            ),
        ),

    getDeploymentSignalStatus: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.getDeploymentSignalStatus(input.applicationId, ctx.organizationId),
        ),

    validatePreviewkitConfig: onboardingWriteProcedure
        // `document` is deliberately unvalidated at the boundary: this procedure's
        // job is to report problems with malformed documents as data, not 400.
        // Preflight covers every repository of the topology in one call.
        .input(
            z.object({
                applicationId: z.string(),
                document: z.unknown(),
            }),
        )
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.validatePreviewkitConfig(input.applicationId, ctx.organizationId, input.document),
        ),

    listDockerfiles: protectedProcedure
        .input(z.object({ applicationId: z.string(), githubRepositoryId: z.number().int().positive().optional() }))
        .query(({ ctx, input }) =>
            ctx.services.onboarding.listDockerfiles(input.applicationId, ctx.organizationId, input.githubRepositoryId),
        ),

    listPreviewkitSecrets: protectedProcedure
        .input(ListSecretsInputSchema)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.listPreviewkitSecrets(input.applicationId, ctx.organizationId, input.appName),
        ),

    upsertPreviewkitSecrets: onboardingWriteProcedure
        .input(UpsertSecretsInputSchema)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.upsertPreviewkitSecrets(
                input.applicationId,
                ctx.organizationId,
                input.appName,
                input.items,
            ),
        ),

    deletePreviewkitSecret: onboardingWriteProcedure
        .input(DeleteSecretInputSchema)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.deletePreviewkitSecret(
                input.applicationId,
                ctx.organizationId,
                input.appName,
                input.key,
            ),
        ),

    triggerPreviewkitMainDeploy: onboardingWriteProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.triggerPreviewkitMainDeploy(input.applicationId, ctx.organizationId),
        ),

    setDeployBranch: onboardingWriteProcedure
        .input(z.object({ applicationId: z.string(), branch: z.string().min(1) }))
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.setDeployBranch(input.applicationId, ctx.organizationId, input.branch),
        ),

    listDeployBranches: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.listDeployBranchOptions(input.applicationId, ctx.organizationId),
        ),

    getPreviewReadiness: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboarding.getPreviewReadiness(input.applicationId, ctx.organizationId),
        ),

    completePreviewOnboarding: onboardingWriteProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) =>
            ctx.services.onboarding.completePreviewOnboarding(input.applicationId, ctx.organizationId),
        ),

    goLive: onboardingWriteProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) => ctx.services.onboarding.goLive(input.applicationId, ctx.organizationId)),

    // A verified preview all the way to live, in one idempotent call. The planner CLI
    // uses this once its preview phase confirms, rather than leaving the transition to
    // a coding agent it is about to stop.
    takeLive: onboardingWriteProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) => ctx.services.onboarding.takeLive(input.applicationId, ctx.organizationId)),

    // --- Agentic onboarding (coding agent drives previewkit config over MCP) ---

    // Poll target for the "Claude is configuring" UI: holder/effectiveHolder,
    // pending request, agent activity stream, and step/verification status.
    getAgentSession: protectedProcedure
        .input(applicationIdInput)
        .query(({ ctx, input }) =>
            ctx.services.onboardingAgentSession.getForUi(input.applicationId, ctx.organizationId),
        ),

    // Mint the pairing code the user hands to their coding agent.
    createAgentPairing: onboardingWriteProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) =>
            ctx.services.onboardingAgentSession.createPairing(input.applicationId, ctx.organizationId),
        ),

    // Stop button: the human takes over; the agent stands down on its next call.
    stopAgent: onboardingWriteProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) =>
            ctx.services.onboardingAgentSession.stopForHuman(input.applicationId, ctx.organizationId),
        ),

    // Resume with Claude: hand control back to the agent.
    resumeAgent: onboardingWriteProcedure
        .input(applicationIdInput)
        .mutation(({ ctx, input }) =>
            ctx.services.onboardingAgentSession.resumeForAgent(input.applicationId, ctx.organizationId),
        ),

    // Answer an agent env request: set the secret values the user entered (they
    // never reach the agent), record which keys they skipped ("I don't have
    // this"), and resolve the pending request so the agent continues. Skips are
    // fed back to the agent so it adapts instead of assuming the value exists.
    submitAgentEnv: onboardingWriteProcedure
        .input(
            z
                .object({
                    applicationId: z.string(),
                    appName: z.string(),
                    items: z.array(SecretItemSchema).max(200),
                    skippedKeys: z.array(z.string().min(1)).max(200).default([]),
                })
                .refine((value) => value.items.length > 0 || value.skippedKeys.length > 0, {
                    message: "Provide at least one value or skip at least one key",
                }),
        )
        .mutation(async ({ ctx, input }) => {
            // Order is deliberate and can't be a DB $transaction: upsert writes to the
            // external secret store (not Postgres), so it can't roll back. Set the
            // secrets first, then resolve the pending request - if the upsert throws,
            // the request stays pending and the user retries; we never clear it
            // prematurely.
            if (input.items.length > 0) {
                await ctx.services.onboarding.upsertPreviewkitSecrets(
                    input.applicationId,
                    ctx.organizationId,
                    input.appName,
                    input.items,
                );
            }
            await ctx.services.onboardingAgentSession.resolvePendingRequest(
                input.applicationId,
                ctx.organizationId,
                input.skippedKeys,
            );
        }),
});
