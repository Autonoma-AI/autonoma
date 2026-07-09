import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY_CONFIG, buildRetry } from "../src/retry";

/** A provider error carrying an explicit retryability signal, like the real SDK produces. */
function apiError(isRetryable: boolean, message = "provider error"): APICallError {
    return new APICallError({ message, url: "https://example.com", requestBodyValues: {}, isRetryable });
}

/** Retry with no wait so attempt-count assertions run instantly under real timers. */
const NO_WAIT = { maxRetries: 5, initialDelayInMs: 0, backoffFactor: 2 } as const;

describe("buildRetry", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns immediately on success without retrying", async () => {
        const op = vi.fn(async () => "value");

        await expect(buildRetry(NO_WAIT)(op)).resolves.toBe("value");
        expect(op).toHaveBeenCalledTimes(1);
    });

    it("retries a transient failure and returns the eventual result", async () => {
        let attempts = 0;
        const op = async () => {
            attempts += 1;
            if (attempts < 3) throw new Error("transient");
            return "recovered";
        };

        await expect(buildRetry(NO_WAIT)(op)).resolves.toBe("recovered");
        expect(attempts).toBe(3);
    });

    it("throws the last error after exhausting maxRetries", async () => {
        let attempts = 0;
        const op = async () => {
            attempts += 1;
            throw new Error(`boom-${attempts}`);
        };

        await expect(buildRetry({ ...NO_WAIT, maxRetries: 2 })(op)).rejects.toThrow("boom-3");
        // maxRetries + 1 total attempts (initial try plus two retries).
        expect(attempts).toBe(3);
    });

    it("retries a retryable provider error", async () => {
        let attempts = 0;
        const op = async () => {
            attempts += 1;
            if (attempts < 3) throw apiError(true);
            return "ok";
        };

        await expect(buildRetry(NO_WAIT)(op)).resolves.toBe("ok");
        expect(attempts).toBe(3);
    });

    it("fails fast on a non-retryable provider error", async () => {
        let attempts = 0;
        const op = async () => {
            attempts += 1;
            throw apiError(false, "unauthorized");
        };

        await expect(buildRetry(NO_WAIT)(op)).rejects.toThrow("unauthorized");
        // No retries: a 4xx-style error will never succeed, so we don't burn the whole schedule on it.
        expect(attempts).toBe(1);
    });

    it("caps the exponential backoff at maxDelayInMs", async () => {
        vi.useFakeTimers();
        let attempts = 0;
        const op = async () => {
            attempts += 1;
            throw apiError(true);
        };

        // backoffFactor 100 would explode to 100s by the second retry; the cap holds each wait to 2s.
        const settled = buildRetry({ maxRetries: 3, initialDelayInMs: 1000, backoffFactor: 100, maxDelayInMs: 2000 })(
            op,
        ).catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toBe(1);

        // First backoff: min(1000, 2000) = 1000ms.
        await vi.advanceTimersByTimeAsync(1000);
        expect(attempts).toBe(2);

        // Uncapped this would be 100_000ms; the cap fires it at 2000ms instead.
        await vi.advanceTimersByTimeAsync(1999);
        expect(attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempts).toBe(3);

        await vi.advanceTimersByTimeAsync(2000);
        await settled;
        expect(attempts).toBe(4);
    });
});

describe("DEFAULT_RETRY_CONFIG", () => {
    it("retries at least 10 times with a bounded backoff", () => {
        expect(DEFAULT_RETRY_CONFIG.maxRetries).toBeGreaterThanOrEqual(10);
        expect(DEFAULT_RETRY_CONFIG.maxDelayInMs).toBeGreaterThan(0);
    });
});
