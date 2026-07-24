import { db, type PreviewkitStatus } from "@autonoma/db";
import { isPreviewUrl, previewOrigin } from "@autonoma/types";
import { resolvePreviewkitBypassToken } from "@autonoma/utils";
import { z } from "zod";
import { env } from "../../env";
import { protectedProcedure, router } from "../../trpc";
import { probePreview } from "./probe-preview";

/**
 * What the deploy status alone tells the waiting page, or undefined when the
 * environment should be up and only a live check can say whether it is serving.
 *
 * Exhaustive on purpose: `satisfies never` means adding a `PreviewkitStatus` value
 * fails to compile here instead of silently landing in the probe branch, where an
 * environment that can never come up would spin forever. (A bare `default: throw`
 * compiles fine with a case missing - it only catches the mistake at runtime.)
 */
function classifyDeployStatus(status: PreviewkitStatus): "gone" | "deploying" | "failed" | undefined {
    switch (status) {
        case "torn_down":
        case "superseded":
            return "gone";
        case "pending":
        case "building":
        case "deploying":
            return "deploying";
        case "failed":
            return "failed";
        case "ready":
            return undefined;
        default: {
            throw new Error(`Unhandled previewkit status: ${String(status satisfies never)}`);
        }
    }
}

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
                            members: { some: { user: { email: user.email } } },
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

    /**
     * Whether a preview is serving yet, for the waiting page to poll.
     *
     * Calling this WAKES a sleeping preview (see `probePreview`) - correct here,
     * because the caller is a person trying to open it. Never reuse it to render a
     * list of environments.
     */
    status: protectedProcedure.input(z.object({ url: z.url() })).query(async ({ input, ctx: { user } }) => {
        if (!isPreviewUrl(input.url, env.INTERNAL_DOMAIN)) return { state: "not_found" as const };

        const environment = await findAuthorizedEnvironment(input.url, user.email);
        // Deliberately does not distinguish "no such preview" from "not your
        // org" - telling one from the other would let any signed-in user probe
        // which previews exist.
        if (environment == null) return { state: "not_found" as const };

        const deployState = classifyDeployStatus(environment.status);
        if (deployState != null) return { state: deployState };

        return { state: await probePreview(input.url) };
    }),
});

async function findAuthorizedEnvironment(url: string, userEmail: string) {
    // Instances store the bare origin, but a link can carry a deep path (a per-bug
    // "Open preview" href points at the failing screen), so match on the origin or
    // every deep link would resolve to "not found".
    const origin = previewOrigin(url);
    if (origin == null) return undefined;

    const instance = await db.previewkitAppInstance.findFirst({
        where: {
            url: origin,
            environment: { organization: { members: { some: { user: { email: userEmail } } } } },
        },
        select: { environment: { select: { status: true } } },
    });
    return instance?.environment;
}
