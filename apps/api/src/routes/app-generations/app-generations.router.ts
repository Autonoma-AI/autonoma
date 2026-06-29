import {
    UpdateSetupBodySchema,
    UploadArtifactsBodySchema,
    UploadScenarioRecipeVersionsBodySchema,
} from "@autonoma/types";
import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

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

    prepareCliSetup: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .mutation(({ ctx: { services, organizationId, user }, input }) =>
            services.applicationSetups.prepareCliSetup(user.id, organizationId, input.applicationId),
        ),

    uploadScenarioRecipeVersions: protectedProcedure
        .input(z.object({ setupId: z.string(), body: UploadScenarioRecipeVersionsBodySchema }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.applicationSetups.uploadScenarioRecipeVersions(input.setupId, organizationId, input.body),
        ),

    uploadArtifacts: protectedProcedure
        .input(z.object({ setupId: z.string(), body: UploadArtifactsBodySchema }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.applicationSetups.uploadArtifacts(input.setupId, organizationId, input.body),
        ),

    updateSetup: protectedProcedure
        .input(z.object({ setupId: z.string(), body: UpdateSetupBodySchema }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.applicationSetups.updateSetup(input.setupId, organizationId, input.body),
        ),
});
