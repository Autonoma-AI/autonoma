import { db, type Prisma, type PreviewkitStatus } from "@autonoma/db";
import { isPreviewUrl, previewOrigin } from "@autonoma/types";
import { resolvePreviewkitBypassToken } from "@autonoma/utils";
import { z } from "zod";
import { env } from "../../env";
import { internalProcedure, protectedProcedure, writeProcedure, router } from "../../trpc";
import type { PreviewLivenessState } from "./preview-liveness.service";
import { probePreview } from "./probe-preview";
import { resolvePreviewLivenessService } from "./resolve-preview-liveness";

/** An environment's advertised URLs: a `{ appName: url }` blob on `previewkitEnvironment.urls`. */
const PreviewUrlsSchema = z.record(z.string(), z.string());

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
     * Per-URL preview power/health state for LIST views, keyed by URL.
     *
     * Read straight from the preview cluster's Kubernetes API, so - unlike `status` above - this NEVER wakes a
     * sleeping preview, and is safe to poll behind a list. A URL whose preview has no live workloads (and every
     * URL when liveness is not configured) resolves to "unknown".
     *
     * Deliberately NOT keyed by a caller-supplied URL list. That shape made a list view ship one URL per row back
     * to the server that had just produced them: at a few hundred rows it is ~10-15KB of `input=`, and a tRPC GET
     * carrying that is rejected at the edge with 414 before any procedure in the batch runs. The two callers each
     * name the SET they want - one application, or the whole fleet - and the URLs are resolved here.
     */
    livenessForApplication: protectedProcedure
        .input(z.object({ applicationId: z.string() }))
        .query(async ({ input, ctx: { organizationId } }): Promise<Record<string, PreviewLivenessState>> => {
            const application = await db.application.findFirst({
                where: { id: input.applicationId, organizationId },
                select: { githubRepositoryId: true },
            });
            if (application?.githubRepositoryId == null) return {};

            return await livenessByUrl({
                organizationId,
                githubRepositoryId: application.githubRepositoryId,
                status: { not: "torn_down" },
            });
        }),

    /**
     * The same map for every preview in the fleet, across organizations - the admin previewkit view, which has no
     * single application to key on. Internal-only, matching the environments list it sits beside.
     *
     * Deliberately uncapped, and it has to stay that way while `listActiveEnvironments` is: the two share a `where`
     * on purpose, and a row the list renders but this query skipped would show a blank badge forever. Truncating
     * one side of that pair is exactly the defect the old URL-array shape had. If the fleet ever needs bounding,
     * bound the LIST first and key this to the page it returns.
     *
     * It is not self-limiting, though: `torn_down` is excluded (6,004 rows), leaving ~1,200 environments - and
     * ~580 of those are `failed` ones months old that nothing tears down, so the set does creep upward. It is two
     * sequential scans costing 3ms and 6ms at that size, which buys a lot of creep before this matters.
     */
    livenessForFleet: internalProcedure.query(
        async (): Promise<Record<string, PreviewLivenessState>> =>
            await livenessByUrl({ status: { not: "torn_down" } }),
    ),
});

/**
 * Liveness for every preview matching `where`, keyed by every URL that reaches it.
 *
 * Both sources of URL are indexed, because the two halves of the product reach a preview by different keys: the
 * PR list renders `previewkitEnvironment.urls`, while the admin view renders the app-instance rows. Every URL of
 * an environment shares its namespace, so they all resolve to the same state.
 */
async function livenessByUrl(
    where: Prisma.PreviewkitEnvironmentWhereInput,
): Promise<Record<string, PreviewLivenessState>> {
    const service = resolvePreviewLivenessService();
    if (service == null) return {};

    const [environments, fleet] = await Promise.all([
        db.previewkitEnvironment.findMany({
            where,
            select: { namespace: true, urls: true, appInstances: { select: { url: true } } },
        }),
        service.getFleet(),
    ]);

    const result: Record<string, PreviewLivenessState> = {};
    for (const environment of environments) {
        const state = service.stateForNamespace(environment.namespace, fleet);
        for (const url of environmentUrls(environment.urls)) result[url] = state;
        for (const instance of environment.appInstances) {
            if (instance.url != null) result[instance.url] = state;
        }
    }
    return result;
}

/** The environment's advertised URLs. A malformed `urls` blob contributes nothing rather than failing the read. */
function environmentUrls(urls: unknown): string[] {
    const parsed = PreviewUrlsSchema.safeParse(urls);
    if (!parsed.success) return [];
    return Object.values(parsed.data).filter((url) => url.length > 0);
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
