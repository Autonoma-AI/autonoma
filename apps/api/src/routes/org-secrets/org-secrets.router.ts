import { DeleteOrgSecretKeyInputSchema, ListOrgSecretsInputSchema, UpsertOrgSecretInputSchema } from "@autonoma/types";
import { protectedProcedure, writeProcedure, router } from "../../trpc";

export const orgSecretsRouter = router({
    list: protectedProcedure
        .input(ListOrgSecretsInputSchema)
        .query(({ ctx: { services, organizationId }, input }) => services.orgSecrets.list(organizationId, input.name)),

    upsert: writeProcedure
        .input(UpsertOrgSecretInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.orgSecrets.upsert(organizationId, input.name, input.items),
        ),

    delete: writeProcedure
        .input(DeleteOrgSecretKeyInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.orgSecrets.delete(organizationId, input.name, input.key),
        ),
});
