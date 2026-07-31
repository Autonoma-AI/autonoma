import type { Logger } from "@autonoma/logger";
import { queryLokiLogs } from "./loki";

/** Line cap per app-logs query; the classifier tool also char-caps and narrows on overflow. */
const APP_LOGS_LIMIT = 150;

/** The Loki querier, injected so the loader is unit-testable with a fake; defaults to the real query. */
export type LogQuerier = typeof queryLokiLogs;

export interface PreviewAppLogsInput {
    /** LogQL line filter the classifier asked for (its get_app_logs regex). */
    regex: string;
    /** The worker's Loki base URL (env.LOKI_URL). */
    lokiUrl: string;
    /** The PR's resolved previewkit namespace. */
    namespace: string;
    startEpoch: number;
    endEpoch: number;
    logger: Logger;
}

/**
 * Load the preview app's Loki logs over the run window.
 *
 * THROWS when the query fails, and takes its endpoint and namespace as required: `get_app_logs` is only
 * registered for a run that has both, so an absent backend is not a state this can be in. A failed query used
 * to come back as prose, which the tool then handed the model as a successful result - so an unreachable Loki
 * was indistinguishable from a quiet app. `AppLogsTool` turns a throw into a `FixableToolError` carrying a
 * suggested next move, which is the difference between the model knowing it was blocked and believing it
 * looked.
 *
 * An EMPTY result is different, and is still stated as FACT ("the app emitted no matching error") rather than
 * left ambiguous, so the classifier cannot fabricate a backend error that is not present. The Loki querier is
 * injected for testing.
 */
export async function loadPreviewAppLogs(
    input: PreviewAppLogsInput,
    queryLogs: LogQuerier = queryLokiLogs,
): Promise<string> {
    const { regex, lokiUrl, namespace, startEpoch, endEpoch, logger } = input;
    logger.info("Querying preview app logs", { extra: { namespace, regex } });
    const page = await queryLogs({
        lokiBaseUrl: lokiUrl,
        namespace,
        startEpoch,
        endEpoch,
        regex,
        limit: APP_LOGS_LIMIT,
    });
    if (page.lines.length === 0) {
        return `No log lines in preview namespace "${namespace}" matched /${regex}/ over the run window (padded +-90s). The app emitted no matching error during the run - do NOT infer a backend error that is not present here.`;
    }
    logger.info("Preview app logs returned", {
        extra: { namespace, lineCount: page.lines.length, truncated: page.truncated },
    });
    const rendered = page.lines.map((entry) => `${offsetOf(entry.timestampNs, startEpoch)}  ${entry.line}`);
    // The cap keeps the NEWEST matches, so a truncated page silently hides the START of the run - exactly
    // where the error that blocked an early step would be. Say so, or "no such error" reads as proven.
    const capNote = page.truncated
        ? `\n\n[This is the most recent ${APP_LOGS_LIMIT} matching lines only - OLDER matches in this window were not returned. Re-call get_app_logs with a tighter regex before concluding an error is absent.]`
        : "";
    return `App logs from preview namespace "${namespace}" matching /${regex}/, oldest first, each stamped with its offset from the run's start:\n${rendered.join("\n")}${capNote}`;
}

/** A log line's position relative to the run's start, so it lines up with the step trace's own offsets. */
function offsetOf(timestampNs: string, startEpoch: number): string {
    const seconds = Number(BigInt(timestampNs) / 1_000_000_000n) - startEpoch;
    const sign = seconds < 0 ? "-" : "+";
    const absolute = Math.abs(seconds);
    return `${sign}${Math.floor(absolute / 60)}:${(absolute % 60).toString().padStart(2, "0")}`;
}
