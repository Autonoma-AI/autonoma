import { z } from "zod";
import { protectedProcedure, router } from "../../trpc";

export const generationsRouter = router({
    list: protectedProcedure
        .input(z.object({ applicationId: z.string().optional() }).optional())
        .query(({ ctx: { services, organizationId }, input }) =>
            services.testGenerations.listGenerations(organizationId, input?.applicationId),
        ),

    detail: protectedProcedure
        .input(z.object({ generationId: z.string() }))
        .query(({ ctx: { services, organizationId, user }, input }) =>
            services.testGenerations.getGenerationDetail(input.generationId, organizationId, user.role === "admin"),
        ),

    delete: protectedProcedure
        .input(z.object({ generationId: z.string() }))
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.testGenerations.deleteGeneration(input.generationId, organizationId),
        ),
});
