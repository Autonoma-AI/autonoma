import type { ClassifierInput } from "./types";

/**
 * What this run's missing capabilities mean the model canNOT prove, or undefined when nothing is missing.
 *
 * Deliberately says nothing about which TOOLS are absent: a tool the run does not have is simply not in the
 * toolset, and the model can see that for itself. What it cannot infer from an empty toolset is the
 * consequence for its verdict - that an unobservable mechanism must not be asserted anyway - so that, and
 * only that, is what this note carries.
 */
export function describeEvidenceLimits(input: ClassifierInput): string | undefined {
    const backendUnreachable = input.preview == null;
    const logsUnreadable = input.loadAppLogs == null;
    if (!backendUnreachable && !logsUnreadable) return undefined;

    if (backendUnreachable && logsUnreadable) {
        return [
            "You cannot read this app's server logs OR query its backend on this run, so you canNOT confirm any",
            "UNSEEN mechanism - a failed or rejected write, a 5xx, a thrown exception. A persistence,",
            "data-integrity, or unseen-backend symptom is therefore UNPROVABLE here: do not raise one above LOW",
            "confidence, and prefer environment_failure / scenario_issue / a labelled hypothesis over a client_bug",
            "you cannot verify. Classify by what you DIRECTLY observed and say plainly what you could not check.",
        ].join(" ");
    }

    if (logsUnreadable) {
        return [
            "You cannot read this app's server logs on this run, but you CAN query its backend - so confirm state",
            "there (whether a write landed, whether a record exists) in place of the logs. Any claim resting",
            "specifically on a log line you could not read stays at LOW confidence until a backend query",
            "corroborates it.",
        ].join(" ");
    }

    return [
        "You cannot query this app's backend on this run, but you CAN read its server logs - use them to confirm",
        "what actually happened. Any claim that needs a live backend query you could not run stays at LOW",
        "confidence.",
    ].join(" ");
}
