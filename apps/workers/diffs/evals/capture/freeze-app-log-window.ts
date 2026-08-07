import { LOKI_MAX_LINE_LIMIT, type LokiLogPage, queryLokiLogs } from "@autonoma/diffs/analysis/logs/loki";
import { causeMessage } from "@autonoma/errors";
import type { Logger } from "@autonoma/logger";
import { env } from "../../src/env";
import type { FrozenAppLogWindow } from "../classifier/classifier-input";

/**
 * How long Loki keeps a line before its compactor deletes it.
 *
 * Confirmed against the running instance rather than taken from the deployment notes, because the value is
 * applied by hand and provisioned from nowhere: `limits_config.retention_period: 31d` with
 * `compactor.retention_enabled: true`. Also confirmed there: `max_query_lookback: 0s`, so a query for an
 * aged-out window returns HTTP 200 with zero streams - indistinguishable from a quiet app unless the age is
 * checked here.
 */
const RETENTION_DAYS = 31;

/**
 * Margin on the retention edge. Deletion is not instantaneous (the compactor runs on an interval and honours a
 * delete delay), so a window that starts a few minutes inside retention may already have lost its oldest lines -
 * and a partial window frozen as complete is exactly the fabricated fact this refuses to write.
 */
const RETENTION_MARGIN_HOURS = 24;

/** How far either side of the run to look for ANY app line, when the run's own window came back empty. */
const CORROBORATION_HOURS = 12;

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

export interface FreezeAppLogWindowInput {
    /** The PR's previewkit namespace, or absent when the preview is not previewkit-managed. */
    namespace?: string;
    /** The run window, exactly as the classifier's loader was given it. */
    startEpoch: number;
    endEpoch: number;
    /** Freeze the case without a window, accepting that the replay will have no `get_app_logs`. */
    skip: boolean;
    logger: Logger;
}

/**
 * Freeze the preview app's log window so a replayed classification can still read it.
 *
 * The window is captured UNFILTERED: production interpolated the model's regex into a LogQL line filter and had
 * Loki evaluate it, so the filter is not knowable here - only the stream it would have run against. Replay
 * applies the regex locally, which is why this reuses `queryLokiLogs` rather than assembling its own query: the
 * stream selector, the window padding, the ordering and the cap semantics all have to be production's, and
 * there is one implementation of them.
 *
 * REFUSES rather than freezing a window it could not read. An empty window is stated to the classifier as the
 * fact "the app emitted no matching error during the run", so a window that came back empty because Loki was
 * unreachable, or because the run has aged out of retention, would bake a fabricated "the app was quiet" into
 * the case permanently. A window that was genuinely queried and genuinely empty is kept - that is a real and
 * common production answer - but it is warned about, because the log shipper has no write-ahead log and an
 * ingestion gap looks identical.
 */
export async function freezeAppLogWindow(input: FreezeAppLogWindowInput): Promise<FrozenAppLogWindow | undefined> {
    const { namespace, startEpoch, endEpoch, logger } = input;
    if (namespace == null) {
        logger.info("Preview is not previewkit-managed, so production had no app-log stream to freeze");
        return undefined;
    }
    if (input.skip) {
        logger.warn("Skipping the app-log window on request; the replay will classify without get_app_logs", {
            extra: { namespace },
        });
        return undefined;
    }

    const lokiUrl = env.LOKI_URL != null && env.LOKI_URL !== "" ? env.LOKI_URL : undefined;
    if (lokiUrl == null) {
        throw new Error(
            `Preview namespace ${namespace} is previewkit-managed, so production classified this run with ` +
                "get_app_logs, but LOKI_URL is not configured here so the window cannot be frozen. Set LOKI_URL " +
                "(it is reachable over Tailscale), or pass --skip-app-logs to capture a case the replay will " +
                "classify without app logs.",
        );
    }
    assertWithinRetention(startEpoch, namespace);

    logger.info("Freezing the preview app-log window", { extra: { namespace, startEpoch, endEpoch } });
    const page = await queryWindow({ lokiUrl, namespace, startEpoch, endEpoch });

    if (page.lines.length === 0) await warnAboutEmptyWindow({ lokiUrl, namespace, startEpoch, endEpoch }, logger);
    if (page.truncated) {
        logger.warn("The app-log window filled its cap; lines older than the oldest frozen one were not captured", {
            extra: { namespace, lines: page.lines.length, cap: LOKI_MAX_LINE_LIMIT },
        });
    }
    logger.info("Froze the preview app-log window", {
        extra: { namespace, lines: page.lines.length, truncated: page.truncated },
    });

    return { namespace, lines: page.lines, windowTruncated: page.truncated };
}

interface WindowQuery {
    lokiUrl: string;
    namespace: string;
    startEpoch: number;
    endEpoch: number;
}

/** The whole padded window, newest-first at the source so a capped window keeps the lines nearest the failure. */
async function queryWindow(query: WindowQuery): Promise<LokiLogPage> {
    try {
        return await queryLokiLogs({
            lokiBaseUrl: query.lokiUrl,
            namespace: query.namespace,
            startEpoch: query.startEpoch,
            endEpoch: query.endEpoch,
            limit: LOKI_MAX_LINE_LIMIT,
        });
    } catch (err) {
        throw new Error(
            `Could not read the app-log window for namespace ${query.namespace}: ${causeMessage(err)}. An ` +
                "unreadable window must not be frozen as an empty one - the classifier would be told the app " +
                "was quiet. Fix the connection and re-run, or pass --skip-app-logs.",
        );
    }
}

/**
 * Refuse a window Loki can no longer be trusted to hold in full.
 *
 * The check is ours to make because an aged-out query succeeds and returns nothing, so nothing downstream can
 * tell it from a healthy app that logged nothing.
 */
function assertWithinRetention(startEpoch: number, namespace: string): void {
    const now = Math.floor(Date.now() / 1000);
    const capturableFrom = now - (RETENTION_DAYS * SECONDS_PER_DAY - RETENTION_MARGIN_HOURS * SECONDS_PER_HOUR);
    if (startEpoch >= capturableFrom) return;

    const ageDays = Math.floor((now - startEpoch) / SECONDS_PER_DAY);
    throw new Error(
        `The run started ${ageDays} days ago, past Loki's ${RETENTION_DAYS}-day retention (less a ` +
            `${RETENTION_MARGIN_HOURS}h margin), so its logs for namespace ${namespace} are gone. Loki answers an ` +
            "aged-out window with an empty result, which would freeze as 'the app emitted no matching error'. " +
            "Capture a more recent classification, or pass --skip-app-logs to accept a case with no app logs.",
    );
}

/**
 * An empty window is a legitimate answer, but not always the one it reads as, so say which kind it is.
 *
 * A namespace that carried no app line for hours either side of the run never had its logs shipped at all - the
 * preview's app streams are absent, not silent - and "the app emitted no matching error" then proves nothing
 * about the app's health, which is exactly the inference the loader's prose invites. Worth knowing before
 * authoring an expectation on it.
 */
async function warnAboutEmptyWindow(query: WindowQuery, logger: Logger): Promise<void> {
    const corroboration = CORROBORATION_HOURS * SECONDS_PER_HOUR;
    const context = { namespace: query.namespace, corroborationHours: CORROBORATION_HOURS };

    // The window itself read cleanly, so a failure here costs the author a warning rather than the case.
    let nearby: LokiLogPage;
    try {
        nearby = await queryLokiLogs({
            lokiBaseUrl: query.lokiUrl,
            namespace: query.namespace,
            startEpoch: query.startEpoch - corroboration,
            endEpoch: query.endEpoch + corroboration,
            limit: 1,
        });
    } catch (err) {
        logger.warn("The app-log window is empty and the wider window could not be checked", { extra: context, err });
        return;
    }

    if (nearby.lines.length === 0) {
        logger.warn(
            "No app lines at all around this run - the preview's app logs were never shipped, so the frozen " +
                "window will tell the classifier 'the app emitted no matching error' without that being " +
                "evidence the app was healthy",
            { extra: context },
        );
        return;
    }
    logger.warn("The app logged nothing during the run, though it logged either side of it", { extra: context });
}
