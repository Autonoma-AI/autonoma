import { logger as rootLogger } from "@autonoma/logger";
import { describe, expect, it } from "vitest";
import type { LogQuerier } from "../../src/analysis/logs/preview-app-logs";
import { loadPreviewAppLogs } from "../../src/analysis/logs/preview-app-logs";

/**
 * The loader states an empty result to the classifier as the FACT that the app emitted no matching error, which
 * is what stops it inventing a backend failure. That makes the honesty of the empty case the thing worth testing:
 * it is only a fact when the page it came from was complete.
 */

const INPUT = {
    regex: "(?i)error",
    namespace: "preview-acme-pr-7",
    startEpoch: 1_770_000_000,
    endEpoch: 1_770_000_120,
    logger: rootLogger.child({ name: "preview-app-logs.test" }),
};

function querierReturning(page: Awaited<ReturnType<LogQuerier>>): LogQuerier {
    return async () => page;
}

describe("loadPreviewAppLogs", () => {
    it("states a complete empty window as fact, so the classifier cannot invent an error", async () => {
        const logs = await loadPreviewAppLogs(INPUT, querierReturning({ lines: [], truncated: false }));

        expect(logs).toContain("The app emitted no matching error during the run");
        expect(logs).toContain("do NOT infer a backend error that is not present here");
    });

    it("refuses to state an INCOMPLETE empty window as fact", async () => {
        // A page that filled its limit was not fully searched, so "nothing matched" covers only part of the
        // window. A live query cannot produce this (its truncation flag IS a full page of matches), but a replay
        // filtering a frozen window that was itself capped can - and the fact would be fabricated.
        const logs = await loadPreviewAppLogs(INPUT, querierReturning({ lines: [], truncated: true }));

        expect(logs).not.toContain("The app emitted no matching error during the run");
        expect(logs).toContain("OLDER lines in this window were never searched");
    });

    it("stamps each returned line with its offset from the run's start", async () => {
        const logs = await loadPreviewAppLogs(
            INPUT,
            querierReturning({
                lines: [
                    { timestampNs: String((INPUT.startEpoch - 30) * 1_000_000_000), line: "ERROR early" },
                    { timestampNs: String((INPUT.startEpoch + 64) * 1_000_000_000), line: "ERROR late" },
                ],
                truncated: false,
            }),
        );

        expect(logs).toContain("-0:30  ERROR early");
        expect(logs).toContain("+1:04  ERROR late");
        expect(logs).not.toContain("OLDER matches");
    });
});
