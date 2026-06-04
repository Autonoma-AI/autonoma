import { db } from "@autonoma/db";
import { resolvePreviewkitBypassToken } from "@autonoma/utils";
import { z } from "zod";
import { env } from "../../env";
import { protectedProcedure, router } from "../../trpc";

export const previewAccessRouter = router({
    issueToken: protectedProcedure
        .input(z.object({ redirectUrl: z.string().url() }))
        .mutation(async ({ input, ctx: { user } }) => {
            const url = input.redirectUrl.replace(/\/$/, "");
            const instance = await db.previewkitAppInstance.findFirst({
                where: {
                    url,
                    environment: {
                        organization: {
                            members: { some: { userId: user.id } },
                        },
                    },
                },
                select: { environment: { select: { bypassToken: true } } },
            });

            if (instance?.environment.bypassToken == null) {
                throw new Error("Preview environment not found or access denied");
            }

            return {
                token: resolvePreviewkitBypassToken(instance.environment.bypassToken, env.PREVIEWKIT_BYPASS_TOKEN_KEY),
            };
        }),
});
