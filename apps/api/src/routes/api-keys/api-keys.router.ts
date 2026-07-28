import { CreateApiKeyInputSchema, DeleteApiKeyInputSchema } from "@autonoma/types";
import { protectedProcedure, writeProcedure, router } from "../../trpc";

export const apiKeysRouter = router({
    list: protectedProcedure.query(({ ctx: { services, organizationId } }) => services.apiKeys.list(organizationId)),

    create: writeProcedure
        .input(CreateApiKeyInputSchema)
        .mutation(({ ctx: { services, user, organizationId }, input }) =>
            services.apiKeys.create(user.id, organizationId, input.name),
        ),

    delete: writeProcedure
        .input(DeleteApiKeyInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.apiKeys.delete(input.keyId, organizationId),
        ),
});
