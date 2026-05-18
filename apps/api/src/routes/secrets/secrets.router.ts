import { DeleteSecretInputSchema, ListSecretsInputSchema, UpsertSecretsInputSchema } from "@autonoma/types";
import { protectedProcedure, router } from "../../trpc";

export const secretsRouter = router({
    list: protectedProcedure
        .input(ListSecretsInputSchema)
        .query(({ ctx: { services, organizationId }, input }) =>
            services.secrets.list(organizationId, input.applicationId, input.appName),
        ),

    upsert: protectedProcedure
        .input(UpsertSecretsInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.secrets.upsert(organizationId, input.applicationId, input.appName, input.items),
        ),

    delete: protectedProcedure
        .input(DeleteSecretInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.secrets.delete(organizationId, input.applicationId, input.appName, input.key),
        ),
});
