import { debugLog } from "./debug";
import { getPostHogConfig } from "./posthog";
import { getSession } from "./session";

/**
 * The current run's id. Printed in failure output as a support reference so a
 * user-reported error maps 1:1 to its `$exception` event(s) and its log records.
 */
export function getRunId(): string {
    return getSession().runId;
}

const pending = new Set<Promise<unknown>>();

/**
 * Fire-and-forget anonymous event capture. Never throws and never blocks the
 * CLI - failures are swallowed. No PII or source code is ever sent.
 */
export function track(event: string, properties: Record<string, unknown> = {}): void {
    const { enabled, key, host } = getPostHogConfig();
    if (!enabled) return;

    const session = getSession();
    const body = JSON.stringify({
        api_key: key,
        event,
        distinct_id: session.distinctId,
        properties: {
            ...properties,
            run_id: session.runId,
            // Ties an event to the onboarding setup it belongs to, so a failed run
            // in the app resolves to this run's events and log records.
            generation_id: session.generationId,
            project_slug: session.projectSlug,
            // Groups a run's events with its log records, which carry the same id
            // as PostHog's `sessionId` log attribute.
            $session_id: session.runId,
            // Only build a person profile when we have a real identity from the app,
            // so the CLI joins the existing funnel person instead of creating a new one.
            $process_person_profile: session.identified,
            cli_version: session.cliVersion,
            // Runtime version - lets us confirm/monitor Node-version-specific
            // failures (e.g. a `util.styleText` crash on Node < 22.13 in old deps).
            node_version: session.nodeVersion,
        },
    });

    const promise = fetch(`${host}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    })
        .catch((err) => {
            debugLog("Analytics capture request failed (ignored)", { err });
        })
        .finally(() => pending.delete(promise));

    pending.add(promise);
}

/**
 * Capture an exception in PostHog error tracking (`$exception` event).
 * Same fire-and-forget guarantees as `track`. Error messages and stacks may
 * reference CLI-internal file paths, never the user's source code.
 */
export function trackError(error: unknown, properties: Record<string, unknown> = {}, handled = true): void {
    const err = error instanceof Error ? error : new Error(String(error));
    track("$exception", {
        ...properties,
        $exception_list: [
            {
                type: err.name,
                value: err.message,
                mechanism: { handled, synthetic: !(error instanceof Error) },
            },
        ],
        error_stack: err.stack,
    });
}

/** Flush in-flight events before exit. Best-effort, bounded by `timeoutMs`. */
export async function flushAnalytics(timeoutMs = 1500): Promise<void> {
    if (pending.size === 0) return;
    await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
}
