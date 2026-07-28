import { ApplicationArchitecture } from "@autonoma/db";
import { z } from "zod";
import { zfd } from "zod-form-data";
import { protectedProcedure, writeProcedure, router } from "../../trpc";

const CreateApplicationMetadataSchema = z.object({
    name: z.string().min(1),
    architecture: z.nativeEnum(ApplicationArchitecture),
    url: z.string().url().optional(),
    file: z.string().min(1).optional(),
    packageUrl: z.string().optional(),
    photo: z.string().min(1).optional(),
});

const CreateApplicationFormDataSchema = zfd.formData({
    metadata: zfd.json(CreateApplicationMetadataSchema),
});

const UpdateDataSchema = z.discriminatedUnion("architecture", [
    z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        architecture: z.literal(ApplicationArchitecture.WEB),
        url: z.url().optional(),
        file: z.string().min(1).optional(),
    }),
    z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        architecture: z.union([z.literal(ApplicationArchitecture.IOS), z.literal(ApplicationArchitecture.ANDROID)]),
        packageUrl: z.string().optional(),
        photo: z.string().min(1).optional(),
    }),
]);

const UpdateSettingsSchema = z.object({
    id: z.string(),
    customInstructions: z.string().max(5000).nullable(),
    testScopeGuidelines: z.string().max(5000).nullable(),
});

export const applicationsRouter = router({
    list: protectedProcedure.query(({ ctx: { services, organizationId } }) =>
        services.applications.listApplications(organizationId),
    ),

    create: writeProcedure
        .input(CreateApplicationFormDataSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.applications.createApplicationFromFormData({
                metadata: input.metadata,
                organizationId,
            }),
        ),

    createMinimal: writeProcedure
        .input(z.object({ name: z.string().min(1) }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.applications.createMinimalApplication(input.name, organizationId),
        ),

    getSharedSecret: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(({ ctx: { services, organizationId }, input }) =>
            services.applications.getSharedSecret(input.applicationId, organizationId),
        ),

    delete: writeProcedure
        .input(z.object({ id: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.applications.deleteApplication(input.id, organizationId),
        ),

    updateData: writeProcedure.input(UpdateDataSchema).mutation(({ ctx: { services, organizationId }, input }) => {
        const { id, ...data } = input;
        return services.applications.updateData(id, organizationId, data);
    }),

    updateSettings: writeProcedure
        .input(UpdateSettingsSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.applications.updateSettings(input.id, organizationId, {
                customInstructions: input.customInstructions,
                testScopeGuidelines: input.testScopeGuidelines,
            }),
        ),
});
