import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../../trpc";

export const authRouter = router({
    me: protectedProcedure.query(({ ctx: { user, organizationId } }) => ({
        user,
        organizationId,
    })),
    orgStatus: publicProcedure.query(({ ctx }) => {
        if (ctx.user == null || ctx.session == null) {
            throw new TRPCError({ code: "UNAUTHORIZED" });
        }
        return ctx.services.auth.getOrgStatus(ctx.user.id);
    }),
    activeOrg: publicProcedure.query(({ ctx }) => {
        if (ctx.user == null || ctx.session == null) {
            throw new TRPCError({ code: "UNAUTHORIZED" });
        }
        if (ctx.session.activeOrganizationId == null) return undefined;
        return ctx.services.auth.getActiveOrg(ctx.session.activeOrganizationId, ctx.session.token);
    }),
});
