import { db, type PreviewkitStatus } from "@autonoma/db";
import { isPreviewUrl, previewOrigin } from "@autonoma/types";
import { resolvePreviewkitBypassToken } from "@autonoma/utils";
import { z } from "zod";
import { env } from "../../env";
import { protectedProcedure, writeProcedure, router } from "../../trpc";
import type { PreviewLivenessState } from "./preview-liveness.service";
import { probePreview } from "./probe-preview";
import { resolvePreviewLivenessService } from "./resolve-preview-liveness";

// A batched liveness poll covers a whole list view at once; cap it so a single
// request can never fan out to an unbounded set.
const MAX_LIVENESS_URLS = 200;

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
    issueToken: writeProcedure
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

    /**
     * Per-URL preview power/health state for LIST views, keyed by the input URL.
     *
     * Read straight from the preview cluster's Kubernetes API, so - unlike
     * `status` above - this NEVER wakes a sleeping preview. Safe to poll behind a
     * list of environments. A URL that is not a preview, not in the caller's org,
     * or has no live workloads (and any URL at all when liveness is not
     * configured) resolves to "unknown".
     */
    liveness: protectedProcedure
        .input(z.object({ urls: z.array(z.url()).max(MAX_LIVENESS_URLS) }))
        .query(async ({ input, ctx: { user } }): Promise<Record<string, PreviewLivenessState>> => {
            const service = resolvePreviewLivenessService();
            if (service == null) return unknownFor(input.urls);

            // Instances store the bare origin; a list URL may be an origin already
            // or carry a path. Normalize, keeping each origin's original URL keys.
            const originByUrl = new Map<string, string>();
            for (const url of input.urls) {
                if (!isPreviewUrl(url, env.INTERNAL_DOMAIN)) continue;
                const origin = previewOrigin(url);
                if (origin != null) originByUrl.set(url, origin);
            }
            const origins = [...new Set(originByUrl.values())];

            // The DB lookup (org-scoped: only the caller's previews resolve to a
            // namespace) and the whole-fleet snapshot are independent.
            const [instances, fleet] = await Promise.all([
                origins.length === 0
                    ? Promise.resolve([])
                    : db.previewkitAppInstance.findMany({
                          where: {
                              url: { in: origins },
                              environment: { organization: { members: { some: { user: { email: user.email } } } } },
                          },
                          select: { url: true, environment: { select: { namespace: true } } },
                      }),
                service.getFleet(),
            ]);

            const namespaceByOrigin = new Map<string, string>();
            for (const instance of instances) {
                // url is nullable in the schema; the `url in origins` filter only
                // ever returns non-null rows, but narrow it for the type.
                if (instance.url != null) namespaceByOrigin.set(instance.url, instance.environment.namespace);
            }

            const result: Record<string, PreviewLivenessState> = {};
            for (const url of input.urls) {
                const origin = originByUrl.get(url);
                const namespace = origin != null ? namespaceByOrigin.get(origin) : undefined;
                result[url] = namespace != null ? service.stateForNamespace(namespace, fleet) : "unknown";
            }
            return result;
        }),
});

function unknownFor(urls: string[]): Record<string, PreviewLivenessState> {
    const result: Record<string, PreviewLivenessState> = {};
    for (const url of urls) result[url] = "unknown";
    return result;
}

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
