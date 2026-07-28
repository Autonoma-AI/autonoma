import {
    UpdateSetupBodySchema,
    UploadArtifactsBodySchema,
    UploadScenarioRecipeVersionsBodySchema,
} from "@autonoma/types";
import { z } from "zod";
import { protectedProcedure, writeProcedure, router } from "../../trpc";

export const applicationSetupsRouter = router({
    getLatest: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.applicationSetups.getLatest(organizationId, input.applicationId),
        ),

    getById: protectedProcedure
        .input(z.object({ setupId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.applicationSetups.getById(input.setupId, organizationId),
        ),

    artifactStatus: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.applicationSetups.artifactStatus(organizationId, input.applicationId),
        ),

    prepareCliSetup: writeProcedure
        .input(z.object({ applicationId: z.string(), pinnedSetupId: z.string().optional() }))
        .mutation(({ ctx: { services, organizationId, user }, input }) =>
            services.applicationSetups.prepareCliSetup(
                user.id,
                organizationId,
                input.applicationId,
                input.pinnedSetupId,
            ),
        ),

    uploadScenarioRecipeVersions: writeProcedure
        .input(z.object({ setupId: z.string(), body: UploadScenarioRecipeVersionsBodySchema }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.applicationSetups.uploadScenarioRecipeVersions(input.setupId, organizationId, input.body),
        ),

    uploadArtifacts: writeProcedure
        .input(z.object({ setupId: z.string(), body: UploadArtifactsBodySchema }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.applicationSetups.uploadArtifacts(input.setupId, organizationId, input.body),
        ),

    updateSetup: writeProcedure
        .input(z.object({ setupId: z.string(), body: UpdateSetupBodySchema }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.applicationSetups.updateSetup(input.setupId, organizationId, input.body),
        ),
});
