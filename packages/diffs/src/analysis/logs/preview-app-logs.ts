import type { Logger } from "@autonoma/logger";
import { queryLokiLogs } from "./loki";

/** Line cap per app-logs query; the classifier tool also char-caps and narrows on overflow. */
const APP_LOGS_LIMIT = 150;

/** The Loki querier, injected so the loader is unit-testable with a fake; defaults to the real query. */
export type LogQuerier = typeof queryLokiLogs;

export interface PreviewAppLogsInput {
    /** LogQL line filter the classifier asked for (its get_app_logs regex). */
    regex: string;
    /** The worker's Loki base URL (env.LOKI_URL); absent when unconfigured. */
    lokiUrl: string | undefined;
    /** The PR's resolved previewkit namespace; absent when it could not be resolved (e.g. torn-down preview). */
    namespace: string | undefined;
    startEpoch: number;
    endEpoch: number;
    logger: Logger;
}

/**
 * Load the preview app's Loki logs over the run window, degrading to a clear, NON-throwing note whenever the
 * logs cannot be fetched - Loki unconfigured, the namespace unresolved, or the query failing - so a missing
 * log backend never breaks classification. Critically, an EMPTY result is stated as FACT ("the app emitted no
 * matching error") rather than left ambiguous, so the classifier cannot fabricate a backend error that is not
 * present (the fabricated-500 false-positive class). The Loki querier is injected for testing.
 */
export async function loadPreviewAppLogs(
    input: PreviewAppLogsInput,
    queryLogs: LogQuerier = queryLokiLogs,
): Promise<string> {
    const { regex, lokiUrl, namespace, startEpoch, endEpoch, logger } = input;
    if (lokiUrl == null || lokiUrl === "") {
        return "App logs are unavailable (no Loki endpoint configured for this worker) - classify from the run, code, and queried data instead.";
    }
    if (namespace == null) {
        return "App logs are unavailable (could not resolve this PR's preview namespace; the preview may have been torn down) - classify from the run, code, and queried data instead.";
    }
    logger.info("Querying preview app logs", { extra: { namespace, regex } });
    try {
        const lines = await queryLogs({
            lokiBaseUrl: lokiUrl,
            namespace,
            startEpoch,
            endEpoch,
            regex,
            limit: APP_LOGS_LIMIT,
        });
        if (lines.length === 0) {
            return `No log lines in preview namespace "${namespace}" matched /${regex}/ over the run window (padded +-90s). The app emitted no matching error during the run - do NOT infer a backend error that is not present here.`;
        }
        logger.info("Preview app logs returned", { extra: { namespace, lineCount: lines.length } });
        return `App logs from preview namespace "${namespace}" matching /${regex}/ over the run window (most recent last):\n${lines.join("\n")}`;
    } catch (error) {
        logger.warn("Failed to query preview app logs", { extra: { namespace }, err: error });
        return `Could not query app logs for namespace "${namespace}": ${error instanceof Error ? error.message : String(error)}. Classify from the run, code, and queried data instead.`;
    }
}
