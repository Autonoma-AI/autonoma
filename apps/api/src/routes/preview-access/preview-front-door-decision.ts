import { isPreviewUrl } from "@autonoma/types";

/** SPA route that authenticates the visitor, waits out the cold start, and bounces to the preview. */
const WAITING_ROUTE = "/preview-waiting";

interface FrontDoorParams {
    to: string | undefined;
    secFetchMode: string | undefined;
    accept: string | undefined;
    appUrl: string;
    internalDomain: string;
}

/** `invalid` -> 400; `passthrough` -> 307 to the raw preview; `waiting` -> 302 to the SPA waiting page. */
export type FrontDoorDecision =
    | { kind: "invalid" }
    | { kind: "passthrough"; location: string }
    | { kind: "waiting"; location: string };

/**
 * The front-door decision, kept in its own env-free module so it is unit-testable
 * without booting the API env. Importing `env` anywhere in this file's module graph
 * would `createEnv`-validate every var at load and fail in a bare unit-test shard,
 * so the env-reading handler lives separately (`preview-front-door.ts`) and passes
 * `appUrl` / `internalDomain` in.
 */
export function resolveFrontDoorRedirect({
    to,
    secFetchMode,
    accept,
    appUrl,
    internalDomain,
}: FrontDoorParams): FrontDoorDecision {
    if (to == null || !isPreviewUrl(to, internalDomain)) return { kind: "invalid" };
    if (!isBrowserNavigation(secFetchMode, accept)) return { kind: "passthrough", location: to };
    return { kind: "waiting", location: `${appUrl}${WAITING_ROUTE}?to=${encodeURIComponent(to)}` };
}

/**
 * Whether this request is a browser opening a page, as opposed to curl, an HTTP
 * library, or an MCP agent. `Sec-Fetch-Mode: navigate` is sent by every current
 * browser on a top-level navigation and by nothing else; the `Accept` check is the
 * fallback for the handful of older browsers that predate Fetch Metadata.
 *
 * Erring toward "not a browser" is the safe direction - that branch returns the
 * same redirect a machine wants, and a browser following it still reaches the app.
 */
function isBrowserNavigation(secFetchMode: string | undefined, accept: string | undefined): boolean {
    if (secFetchMode != null) return secFetchMode === "navigate";
    return accept != null && accept.includes("text/html");
}
