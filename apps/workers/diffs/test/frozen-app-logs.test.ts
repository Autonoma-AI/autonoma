import { APP_LOGS_LIMIT } from "@autonoma/diffs/analysis";
import { logger as rootLogger } from "@autonoma/logger";
import { describe, expect, it } from "vitest";
import type { FrozenAppLogWindow } from "../evals/classifier/classifier-input";
import { createFrozenAppLogsLoader } from "../evals/classifier/frozen-app-logs";

/**
 * A replayed `get_app_logs` has to answer with what production answered with. The prose is production's own
 * loader, so what is tested here is the half Loki does: which lines a filter selects, which survive the
 * cap, and whether the model is warned that older matches were hidden - the last of which is what stops
 * "no matching error" reading as proof that no error existed.
 *
 * The filters are written in RE2, the language Loki evaluates, including the constructs JS `RegExp` rejects or
 * reads differently.
 */

const NAMESPACE = "preview-acme-storefront-pr-7";
const ERROR_FILTER = "(?i)error|fatal|econnrefused";
const START_EPOCH = 1_770_000_000;
const END_EPOCH = 1_770_000_120;
const NANOS_PER_SECOND = 1_000_000_000n;

const logger = rootLogger.child({ name: "frozen-app-logs.test" });

/** A frozen window, each line placed by its offset in seconds from the run's start (negative = the padding). */
function frozenWindow(lines: { at: number; line: string }[], windowTruncated = false): FrozenAppLogWindow {
    return {
        namespace: NAMESPACE,
        lines: lines.map(({ at, line }) => ({
            timestampNs: String(BigInt(START_EPOCH + at) * NANOS_PER_SECOND),
            line,
        })),
        windowTruncated,
    };
}

function loaderFor(window: FrozenAppLogWindow) {
    return createFrozenAppLogsLoader({ window, startEpoch: START_EPOCH, endEpoch: END_EPOCH, logger });
}

describe("createFrozenAppLogsLoader", () => {
    it("returns the matching lines oldest first, stamped with their offset from the run's start", async () => {
        const loadAppLogs = loaderFor(
            frozenWindow([
                { at: -30, line: "boot: listening on :3000" },
                { at: 12, line: "GET /orders 200" },
                { at: 64, line: "ERROR checkout failed: ECONNREFUSED redis:6379" },
                { at: 70, line: "GET /health 200" },
            ]),
        );

        const logs = await loadAppLogs(ERROR_FILTER);

        expect(logs).toContain(`App logs from preview namespace "${NAMESPACE}"`);
        expect(logs).toContain("+1:04  ERROR checkout failed: ECONNREFUSED redis:6379");
        expect(logs).not.toContain("GET /health");
        expect(logs).not.toContain("most recent");
    });

    it("stamps a line from the window's leading padding with a negative offset", async () => {
        const loadAppLogs = loaderFor(frozenWindow([{ at: -45, line: "FATAL migrations pending" }]));

        expect(await loadAppLogs(ERROR_FILTER)).toContain("-0:45  FATAL migrations pending");
    });

    it("states an unmatched window as the fact production stated it as", async () => {
        const loadAppLogs = loaderFor(frozenWindow([{ at: 5, line: "GET /orders 200" }]));

        const logs = await loadAppLogs("(?i)error");

        expect(logs).toContain("The app emitted no matching error during the run");
        expect(logs).toContain(NAMESPACE);
    });

    it("keeps the newest matches when they overflow the cap, and says older ones were hidden", async () => {
        const overflowing = Array.from({ length: APP_LOGS_LIMIT + 20 }, (_unused, index) => ({
            at: index,
            line: `ERROR request ${index} failed`,
        }));

        const logs = await loaderFor(frozenWindow(overflowing))(ERROR_FILTER);

        // The newest are kept: the run ends at or near the step that failed, so those are the lines nearest it.
        expect(logs).toContain("ERROR request 169 failed");
        expect(logs).not.toContain("ERROR request 19 failed");
        expect(logs).toContain("OLDER matches in this window were not returned");
    });

    it("warns about hidden older matches when the frozen window itself was capped", async () => {
        // Two matches is nowhere near the cap, but the window they came from was incomplete, so matches older
        // than its oldest line exist and were never captured. Production said so; a replay must too.
        const capped = frozenWindow(
            [
                { at: 3, line: "ERROR one" },
                { at: 9, line: "ERROR two" },
            ],
            true,
        );

        const logs = await loaderFor(capped)(ERROR_FILTER);

        expect(logs).toContain("ERROR one");
        expect(logs).toContain("OLDER matches in this window were not returned");
    });

    it("does not state a capped window as quiet when the filter matches none of its lines", async () => {
        // The shape only a replay can produce: zero matches over a window that is itself missing its older
        // lines. Stating "the app emitted no matching error" here would be exactly the fabricated fact the
        // freeze exists to prevent, so the loader must qualify it instead.
        const logs = await loaderFor(frozenWindow([{ at: 8, line: "GET /orders 200" }], true))("(?i)error");

        expect(logs).not.toContain("The app emitted no matching error during the run");
        expect(logs).toContain("OLDER lines in this window were never searched");
    });

    it("rejects a filter RE2 rejects, rather than reporting an empty window", async () => {
        // The tool turns a throw into "could not read the app logs", which is what the classifier was told when
        // Loki rejected the same pattern with an HTTP 400. Answering "no matching lines" would invent evidence
        // of a healthy app.
        const loadAppLogs = loaderFor(frozenWindow([{ at: 4, line: "ERROR checkout failed" }]));

        await expect(loadAppLogs("checkout(?=.*retried)")).rejects.toThrow(/Perl syntax/);
        await expect(loadAppLogs("(err)or\\1")).rejects.toThrow(/invalid escape sequence/);
    });

    /**
     * The constructs RE2 accepts and JS `RegExp` does not, or reads differently. Production serves all of them,
     * so a replay that refuses one answers "could not read the app logs" for a call that succeeded - fabricating
     * an inability, which misleads the classifier exactly as a fabricated fact would.
     */
    it("serves the RE2 constructs a JS RegExp cannot express", async () => {
        const loadAppLogs = loaderFor(
            frozenWindow([
                { at: 3, line: "checkout FAILED: upstream 503" },
                { at: 9, line: "GET /health 200" },
            ]),
        );

        expect(await loadAppLogs("(?i:CHECKOUT)")).toContain("checkout FAILED"); // scoped flag group
        expect(await loadAppLogs("checkout (?i)failed")).toContain("checkout FAILED"); // mid-pattern flag
        expect(await loadAppLogs("\\p{Lu}+: upstream")).toContain("checkout FAILED"); // unicode class
        expect(await loadAppLogs("\\x{35}03")).toContain("checkout FAILED"); // RE2 code point
    });
});
