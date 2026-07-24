import { logger as rootLogger } from "@autonoma/logger";

/**
 * How long to wait for the preview to answer before calling it cold. A warm
 * preview responds well inside this; a sleeping one sends no bytes at all while
 * the proxy holds the request, so the timeout IS the signal.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Body the access proxy returns while a namespace is waking or wedged. It answers
 * with a real 503 rather than holding, so "we got a response" alone would wrongly
 * read as warm. Matched on the body because the status code cannot tell this apart
 * from the customer app's own 503.
 */
const PROXY_WAKING_BODY = "Service is waking up";

/** Same, for the brief window when a request lands on a non-leader proxy replica. */
const PROXY_FAILOVER_BODY = "Not the active replica";

export type PreviewLiveness = "ready" | "waking";

/**
 * Asks a preview whether it is serving yet.
 *
 * This request deliberately WAKES a sleeping preview - that is the point, the
 * visitor is trying to reach it. Do not reuse this to render a list of
 * environments: one page load would wake every preview on it and defeat
 * scale-to-zero entirely. A list needs the proxy's in-memory power state instead.
 *
 * Aborting after {@link PROBE_TIMEOUT_MS} does not cancel the wake - the proxy runs
 * it on a detached context precisely so a disconnecting client cannot abort a wake
 * others are waiting on. So a short probe starts the wake and returns promptly.
 */
export async function probePreview(url: string): Promise<PreviewLiveness> {
    const logger = rootLogger.child({ name: "probePreview" });

    try {
        const response = await fetch(url, {
            method: "GET",
            // Following a redirect could take us off the preview origin and burn the
            // budget on someone else's server; the status line is all we need.
            redirect: "manual",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });

        if (response.status === 503 && (await isProxyHoldingResponse(response))) {
            logger.info("Preview proxy reports the environment is not serving yet", { extra: { url } });
            return "waking";
        }

        logger.info("Preview answered", { extra: { url, status: response.status } });
        return "ready";
    } catch (err) {
        // A timeout is the expected outcome for a cold preview, not a fault: the
        // proxy is holding our request while the pods start. Anything else here
        // (DNS, TLS, connection reset mid-wake) also means "not serving yet", so
        // they collapse to the same answer - logged at debug to keep a breadcrumb
        // without treating a normal cold start as an error.
        logger.debug("Preview did not answer within the probe budget", {
            extra: { url, error: err instanceof Error ? err.message : String(err) },
        });
        return "waking";
    }
}

async function isProxyHoldingResponse(response: Response): Promise<boolean> {
    try {
        const body = await response.text();
        return body.includes(PROXY_WAKING_BODY) || body.includes(PROXY_FAILOVER_BODY);
    } catch (err) {
        rootLogger.child({ name: "probePreview" }).debug("Could not read the 503 body, assuming the app served it", {
            extra: { error: err instanceof Error ? err.message : String(err) },
        });
        return false;
    }
}
