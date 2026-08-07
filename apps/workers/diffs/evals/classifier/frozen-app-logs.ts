import { type LogQuerier, loadPreviewAppLogs } from "@autonoma/diffs/analysis";
import type { LokiLogLine } from "@autonoma/diffs/analysis/logs/loki";
import type { Logger } from "@autonoma/logger";
import { RE2JS } from "re2js";
import type { FrozenAppLogWindow } from "./classifier-input";

export interface FrozenAppLogsInput {
    window: FrozenAppLogWindow;
    /** The run window the case was frozen over - the same epochs production's loader was given. */
    startEpoch: number;
    endEpoch: number;
    logger: Logger;
}

/**
 * Serve `get_app_logs` from a frozen log window.
 *
 * The rendering is NOT reimplemented: this hands the production loader a querier that reads the frozen window
 * instead of Loki, so the namespace header, the per-line run offsets, the truncation warning and the
 * "the app emitted no matching error - do NOT infer a backend error that is not present" fact all come out
 * of the same code that produced them in production, byte for byte.
 *
 * What IS reimplemented is the part Loki did server-side: applying the model's regex to the stream and capping
 * the result. See {@link frozenQuerier}.
 */
export function createFrozenAppLogsLoader(input: FrozenAppLogsInput): (regex: string) => Promise<string> {
    const querier = frozenQuerier(input.window);
    return (regex: string) =>
        loadPreviewAppLogs(
            {
                regex,
                namespace: input.window.namespace,
                startEpoch: input.startEpoch,
                endEpoch: input.endEpoch,
                logger: input.logger,
            },
            querier,
        );
}

/**
 * Loki's server-side half of a `get_app_logs` call, evaluated locally over the frozen window.
 *
 * Three things have to match production exactly, because the loader's prose states each of them to the model as
 * fact:
 *
 * - **Which lines match.** Loki evaluates a line filter with Go's `regexp`, whose language is RE2 - a different
 *   language from JS `RegExp`, accepting inline flag groups and `\p{...}` that JS rejects or silently misreads,
 *   and rejecting the lookaround and backreferences JS allows. So the filter runs through an RE2 engine here
 *   too, rather than through a translation whose equivalence would have to be argued pattern by pattern. A
 *   pattern RE2 rejects throws, which the tool turns into "could not read the app logs" - the same outcome the
 *   pattern had in production, where Loki answered it with an HTTP 400.
 *
 *   One pattern class still diverges, in the direction of replay seeing MORE: Loki's line-filter simplifier
 *   mis-evaluates `<literal>.*(a|b)` when the literal occurs again after the alternation's match. Measured on a
 *   live preview, `mongo.*down` matched a line that `mongo.*(fail|down)` did not, the line carrying `mongo` at
 *   offsets 116 and 912 and `down` at 200 - and a real RE2 engine matches it, so this is Loki's own bug rather
 *   than an artefact of evaluating the pattern here. Not emulated: it would have to be un-emulated when fixed.
 * - **Which matches survive the cap.** Production asked Loki for the window newest-first and kept the newest
 *   `limit`, so the lines nearest the failure are the ones that reach the model. The frozen window is already
 *   ascending, so keeping its tail keeps the same set.
 * - **Whether anything was hidden.** A truncated page makes the loader warn that OLDER lines were not searched,
 *   which is what stops "no such error" reading as proven. That is true either because the matches themselves
 *   overflow the cap, or because the frozen window overflowed its own - in which case older matches may exist
 *   that were never captured, and the warning must fire however few matches this filter found, ZERO included.
 */
function frozenQuerier(window: FrozenAppLogWindow): LogQuerier {
    return async ({ regex, limit }) => {
        const matched = matchingLines(window.lines, regex);
        return { lines: matched.slice(-limit), truncated: matched.length >= limit || window.windowTruncated };
    };
}

/** The window's lines that the filter keeps, in the order they were captured. */
function matchingLines(lines: LokiLogLine[], regex: string): LokiLogLine[] {
    const pattern = RE2JS.compile(regex);
    return lines.filter((entry) => pattern.matcher(entry.line).find());
}
