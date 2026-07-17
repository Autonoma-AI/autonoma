import { describe, expect, it } from "vitest";
import { deriveLogLevel, matchesLevelFilter } from "./build-log-stream-viewer";
import type { BuildLogEntry } from "./use-build-log-stream";

function logEntry(stream: "stdout" | "stderr" | undefined, message = "line"): BuildLogEntry {
    const entry: BuildLogEntry = { id: "1", kind: "log", message };
    if (stream != null) entry.stream = stream;
    return entry;
}

function phaseEntry(): BuildLogEntry {
    return { id: "1", kind: "phase", message: "building-images" };
}

function statusEntry(): BuildLogEntry {
    return { id: "1", kind: "status", message: "failed" };
}

describe("deriveLogLevel", () => {
    it("derives error from stderr", () => {
        expect(deriveLogLevel(logEntry("stderr"))).toBe("error");
    });

    it("derives info from stdout", () => {
        expect(deriveLogLevel(logEntry("stdout"))).toBe("info");
    });

    it("derives info when stream is absent, regardless of message content", () => {
        expect(deriveLogLevel(logEntry(undefined, "0 errors found"))).toBe("info");
    });
});

describe("matchesLevelFilter", () => {
    it('shows everything when the filter is "all"', () => {
        expect(matchesLevelFilter(logEntry("stdout"), "all")).toBe(true);
        expect(matchesLevelFilter(logEntry("stderr"), "all")).toBe(true);
    });

    it("always shows phase and status markers, regardless of the filter", () => {
        expect(matchesLevelFilter(phaseEntry(), "error")).toBe(true);
        expect(matchesLevelFilter(statusEntry(), "error")).toBe(true);
    });

    it('"info" is the floor - it shows both stdout and stderr log entries', () => {
        expect(matchesLevelFilter(logEntry("stdout"), "info")).toBe(true);
        expect(matchesLevelFilter(logEntry("stderr"), "info")).toBe(true);
    });

    it('"error" shows only stderr log entries', () => {
        expect(matchesLevelFilter(logEntry("stderr"), "error")).toBe(true);
        expect(matchesLevelFilter(logEntry("stdout"), "error")).toBe(false);
    });
});
