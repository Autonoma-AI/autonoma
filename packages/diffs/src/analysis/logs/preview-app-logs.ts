import type { Logger } from "@autonoma/logger";
import type { LokiLogPage } from "./loki";

/**
 * Line cap per app-logs query; the classifier tool also char-caps and narrows on overflow.
 *
 * The only cap the model's view is subject to, so anything reproducing this read - a replayed window, a test
 * building an overflowing fixture - has to cap at the same number rather than at one that happens to match.
 */
export const APP_LOGS_LIMIT = 150;

/**
 * What the loader needs of a log source, which is NOT the transport's own signature.
 *
 * Typed to the question being asked (this filter, this window, this many lines) rather than to `queryLokiLogs`,
 * so the endpoint stays where it is known - bound once by the worker - instead of becoming a field every caller
 * must supply and a replayed window has to invent.
 */
export type LogQuerier = (query: {
    namespace: string;
    startEpoch: number;
    endEpoch: number;
    regex: string;
    limit: number;
}) => Promise<LokiLogPage>;

export interface PreviewAppLogsInput {
    /** LogQL line filter the classifier asked for (its get_app_logs regex). */
    regex: string;
    /** The PR's resolved previewkit namespace. */
    namespace: string;
    startEpoch: number;
    endEpoch: number;
    logger: Logger;
}

/**
 * Load the preview app's Loki logs over the run window.
 *
 * THROWS when the query fails, and takes its querier and namespace as required: `get_app_logs` is only
 * registered for a run that has both, so an absent backend is not a state this can be in - the querier being a
 * parameter rather than a default is what makes that structural. A failure must never come back as prose: the
 * tool would hand it to the model as a successful result, leaving an unreachable Loki indistinguishable from a
 * quiet app. `AppLogsTool` turns a throw into a `FixableToolError` carrying a suggested next move, which is the
 * difference between the model knowing it was blocked and believing it looked.
 *
 * An EMPTY result is different, and is stated as FACT ("the app emitted no matching error") rather than left
 * ambiguous, so the classifier cannot fabricate a backend error that is not present - but only when the page it
 * came from was complete, since nothing matching PART of a window proves nothing happened in it. The querier is
 * injected, both for tests and to replay a frozen window through this same rendering.
 */
export async function loadPreviewAppLogs(input: PreviewAppLogsInput, queryLogs: LogQuerier): Promise<string> {
    const { regex, namespace, startEpoch, endEpoch, logger } = input;
    logger.info("Querying preview app logs", { extra: { namespace, regex } });
    const page = await queryLogs({ namespace, startEpoch, endEpoch, regex, limit: APP_LOGS_LIMIT });
    if (page.lines.length === 0) {
        logger.info("Preview app logs matched nothing", { extra: { namespace, truncated: page.truncated } });
        return describeEmptyWindow(namespace, regex, page.truncated);
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

/**
 * An empty result, stated as the FACT that stops the classifier inventing a backend error - unless the page it
 * came from was incomplete, in which case that fact would be fabricated.
 *
 * A page that filled its limit was not searched to the end of the window, so "nothing matched" covers only the
 * part that was read. A live query cannot reach this combination, because its truncation flag IS a full page of
 * matches; a replayed one can, when the frozen window it filters was itself capped at capture.
 */
function describeEmptyWindow(namespace: string, regex: string, truncated: boolean): string {
    const nothingMatched = `No log lines in preview namespace "${namespace}" matched /${regex}/ over the run window (padded +-90s).`;
    if (!truncated) {
        return `${nothingMatched} The app emitted no matching error during the run - do NOT infer a backend error that is not present here.`;
    }
    return `${nothingMatched} This is NOT evidence the app was quiet: the log read was capped, so OLDER lines in this window were never searched. Treat the absence of a match as UNKNOWN, and prefer evidence you can see over a backend error you cannot rule out.`;
}

/** A log line's position relative to the run's start, so it lines up with the step trace's own offsets. */
function offsetOf(timestampNs: string, startEpoch: number): string {
    const seconds = Number(BigInt(timestampNs) / 1_000_000_000n) - startEpoch;
    const sign = seconds < 0 ? "-" : "+";
    const absolute = Math.abs(seconds);
    return `${sign}${Math.floor(absolute / 60)}:${(absolute % 60).toString().padStart(2, "0")}`;
}
