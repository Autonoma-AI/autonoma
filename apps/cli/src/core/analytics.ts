import { debugLog } from "./debug";
import { writeDebugRecord } from "./debug-sink";
import { getPostHogConfig } from "./posthog";
import { getRuntimeContext } from "./runtime-context";
import { getDeviceId, getSession, markAliasedTo, readAliasedTo } from "./session";

/**
 * The current run's id. Printed in failure output as a support reference so a
 * user-reported error maps 1:1 to its `$exception` event(s) and its log records.
 */
export { getRunId } from "./run-id";

const pending = new Set<Promise<unknown>>();

/**
 * Fire-and-forget anonymous event capture. Never throws and never blocks the
 * CLI - failures are swallowed. Events carry metadata only, never the user's
 * source. (Session replay is the lane that does capture the screen - see
 * `replay/session-recorder.ts`.)
 */
export function track(event: string, properties: Record<string, unknown> = {}): void {
    const session = getSession();
    // Mirrored before the opt-out check: a DONT_TRACK run still deserves a local
    // transcript, and that is the run most likely to need one.
    writeDebugRecord(session.runId, "event", { event, ...properties });

    const { enabled, key, host } = getPostHogConfig();
    if (!enabled) return;

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
            // Host facts - which machine, terminal and shell this ran on. Failures
            // that depend on the environment are indistinguishable without them.
            ...getRuntimeContext(),
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

/**
 * Tell PostHog that this machine's anonymous history and the identified person
 * are the same entity.
 *
 * Before the app hands over a distinct id, runs are attributed to a per-machine
 * device id and build no person profile. Without this they stay orphaned: the
 * person's history begins at onboarding, and everything they did with the CLI
 * beforehand is unreachable from their profile. `$identify` with
 * `$anon_distinct_id` merges the two retroactively.
 *
 * Sent once per (machine, person). The marker records which person it was, so a
 * machine that later belongs to someone else is linked again rather than staying
 * attached to the first.
 */
export function linkAnonymousHistory(): void {
    const session = getSession();
    if (!session.identified) return;

    const deviceId = getDeviceId();
    if (deviceId === session.distinctId) return;
    if (readAliasedTo() === session.distinctId) return;

    track("$identify", { $anon_distinct_id: deviceId });
    // Only remember the link once it can actually have been sent. Under DONT_TRACK
    // the capture is a no-op, and marking anyway would spend the one chance to make
    // this link - a later opted-in run would find the marker and stay silent.
    if (!getPostHogConfig().enabled) return;
    markAliasedTo(session.distinctId);
    debugLog("Linked this machine's anonymous history to the identified person", {
        deviceId,
        distinctId: session.distinctId,
    });
}
