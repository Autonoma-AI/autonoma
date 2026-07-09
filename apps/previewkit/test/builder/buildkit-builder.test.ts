import { describe, expect, it } from "vitest";
import { TRANSIENT_NETWORK_PATTERNS } from "../../src/builder/buildkit-builder";

/** Mirrors the check in BuildKitBuilder.exec: any pattern hit in the combined output tail marks the failure transient. */
function isTransient(outputTail: string): boolean {
    return TRANSIENT_NETWORK_PATTERNS.some((p) => p.test(outputTail));
}

describe("TRANSIENT_NETWORK_PATTERNS", () => {
    it("classifies session-loss errors from a starved pool pod as transient", () => {
        const sessionLossTails = [
            "error: failed to solve: no active session for p8vvbrjdbtxfam6jrbdj8bhbn: context deadline exceeded",
            "rpc error: code = Unknown desc = session healthcheck failed: rpc error: code = DeadlineExceeded desc = context deadline exceeded",
            "error: failed to solve: failed to get session: context deadline exceeded",
        ];
        for (const tail of sessionLossTails) {
            expect(isTransient(tail), tail).toBe(true);
        }
    });

    it("classifies pod-shutdown and connection errors as transient", () => {
        const connectionTails = [
            "buildkitd is shutting down: graceful_stop",
            "error: failed to solve: rpc error: code = Unavailable desc = error reading from server: EOF",
            "dial tcp 10.0.1.7:1234: connect: connection refused",
        ];
        for (const tail of connectionTails) {
            expect(isTransient(tail), tail).toBe(true);
        }
    });

    it("does not classify a bare in-build deadline as transient", () => {
        // Without session/dial wording, "context deadline exceeded" can come from
        // a deterministic in-build timeout that a retry would only replay.
        expect(isTransient("error: failed to solve: process did not complete: context deadline exceeded")).toBe(false);
    });

    it("does not classify an ordinary build failure as transient", () => {
        const buildFailureTail =
            'error: failed to solve: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1';
        expect(isTransient(buildFailureTail)).toBe(false);
    });
});
