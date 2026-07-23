import { logger } from "@autonoma/logger";
import { describe, expect, it, vi } from "vitest";
import { isColdStartError, isColdStartMessage, withColdStartRetry } from "../src/cold-start-retry";
import { SdkHttpError } from "../src/sdk-http-error";

const testLogger = logger.child({ name: "cold-start-retry.test" });
const noSleep = async (): Promise<void> => {};

describe("isColdStartError", () => {
    it("treats gateway statuses (502/503/504) as cold starts", () => {
        expect(isColdStartError(new SdkHttpError(502, "bad gateway"))).toBe(true);
        expect(isColdStartError(new SdkHttpError(503, "SDK returned HTTP 503: Service is unavailable"))).toBe(true);
        expect(isColdStartError(new SdkHttpError(504, "gateway timeout"))).toBe(true);
    });

    it("does not treat real app errors as cold starts", () => {
        expect(isColdStartError(new SdkHttpError(500, "internal error"))).toBe(false);
        expect(isColdStartError(new SdkHttpError(400, "bad recipe"))).toBe(false);
        expect(isColdStartError(new SdkHttpError(401, "unauthorized"))).toBe(false);
    });

    it("treats connection refused/reset as cold starts, but not a request timeout", () => {
        expect(isColdStartError(new Error("fetch failed"))).toBe(true);
        // The shape SdkClient produces once it folds undici's cause into the message.
        expect(isColdStartError(new Error("fetch failed: connect ECONNREFUSED 10.0.0.1:443"))).toBe(true);
        expect(isColdStartError(new Error("connect ECONNREFUSED 10.0.0.1:443"))).toBe(true);
        expect(isColdStartError(new Error("read ECONNRESET"))).toBe(true);
        expect(isColdStartError(new Error("socket hang up"))).toBe(true);
        // A timeout burns the full budget and is more likely a hung endpoint - not retried.
        expect(isColdStartError(new Error("SDK call timed out after 90s - ensure your endpoint is reachable"))).toBe(
            false,
        );
        expect(isColdStartError("not an error")).toBe(false);
    });
});

describe("isColdStartMessage", () => {
    it("detects a cold start from a persisted error string", () => {
        // The exact shape scenarioInstance.lastError holds after an SdkHttpError.
        expect(
            isColdStartMessage("SDK returned HTTP 503: Error parsing response: Unexpected token 'S', \"Service is\""),
        ).toBe(true);
        expect(isColdStartMessage("SDK returned HTTP 502: bad gateway")).toBe(true);
        expect(isColdStartMessage("fetch failed")).toBe(true);
        expect(isColdStartMessage("SDK returned HTTP 500: recipe factory threw")).toBe(false);
        expect(isColdStartMessage("SDK call timed out after 90s")).toBe(false);
    });
});

describe("withColdStartRetry", () => {
    it("retries through cold starts and returns the warm result", async () => {
        let attempts = 0;
        const work = vi.fn(async () => {
            attempts++;
            if (attempts < 3) throw new SdkHttpError(503, "cold");
            return "warm";
        });

        const result = await withColdStartRetry(work, { logger: testLogger, delaysMs: [0, 0, 0], sleep: noSleep });

        expect(result).toBe("warm");
        expect(work).toHaveBeenCalledTimes(3);
    });

    it("throws a non-cold-start error immediately without retrying", async () => {
        const work = vi.fn(async () => {
            throw new SdkHttpError(400, "bad recipe");
        });

        await expect(
            withColdStartRetry(work, { logger: testLogger, delaysMs: [0, 0], sleep: noSleep }),
        ).rejects.toThrow("bad recipe");
        expect(work).toHaveBeenCalledTimes(1);
    });

    it("re-throws the last cold-start error when the endpoint stays cold", async () => {
        const work = vi.fn(async () => {
            throw new SdkHttpError(503, "still cold");
        });

        await expect(
            withColdStartRetry(work, { logger: testLogger, delaysMs: [0, 0], sleep: noSleep }),
        ).rejects.toThrow("still cold");
        // one initial attempt plus two scheduled retries
        expect(work).toHaveBeenCalledTimes(3);
    });
});
