import { APICallError } from "ai";
import { describe, expect, test } from "vitest";
import {
    withRetry,
    classifyAgentError,
    formatException,
    describeKnownError,
    supportReference,
    isUserCancellation,
    AgentError,
    ToolError,
} from "../../src/core/errors";

describe("withRetry", () => {
    test("returns on first success", async () => {
        let calls = 0;
        const result = await withRetry(async () => {
            calls++;
            return "ok";
        });
        expect(result).toBe("ok");
        expect(calls).toBe(1);
    });

    test("retries on retryable errors", async () => {
        let calls = 0;
        const result = await withRetry(
            async () => {
                calls++;
                if (calls < 3) throw new Error("rate limit exceeded");
                return "ok";
            },
            { maxRetries: 3, baseDelayMs: 10 },
        );
        expect(result).toBe("ok");
        expect(calls).toBe(3);
    });

    test("throws after max retries", async () => {
        let calls = 0;
        await expect(
            withRetry(
                async () => {
                    calls++;
                    throw new Error("rate limit exceeded");
                },
                { maxRetries: 2, baseDelayMs: 10 },
            ),
        ).rejects.toThrow("rate limit");
        expect(calls).toBe(2);
    });

    test("does not retry non-retryable errors", async () => {
        let calls = 0;
        await expect(
            withRetry(
                async () => {
                    calls++;
                    throw new Error("invalid input");
                },
                { maxRetries: 3, baseDelayMs: 10 },
            ),
        ).rejects.toThrow("invalid input");
        expect(calls).toBe(1);
    });

    test("respects custom shouldRetry", async () => {
        let calls = 0;
        const result = await withRetry(
            async () => {
                calls++;
                if (calls < 2) throw new Error("custom error");
                return "ok";
            },
            {
                maxRetries: 3,
                baseDelayMs: 10,
                shouldRetry: (err) => err instanceof Error && err.message === "custom error",
            },
        );
        expect(result).toBe("ok");
        expect(calls).toBe(2);
    });
});

describe("classifyAgentError", () => {
    function apiError(statusCode: number): APICallError {
        return new APICallError({
            message: `HTTP ${statusCode}`,
            url: "https://example.com",
            requestBodyValues: {},
            statusCode,
            responseHeaders: {},
            responseBody: "",
        });
    }

    test("timeout messages classify as timeout", () => {
        expect(classifyAgentError(new Error("step timed out"))).toBe("timeout");
        expect(classifyAgentError(new Error("request timeout"))).toBe("timeout");
        expect(classifyAgentError(new Error("operation was aborted"))).toBe("timeout");
    });

    test("retryable API status codes classify as transient", () => {
        expect(classifyAgentError(apiError(429))).toBe("transient");
        expect(classifyAgentError(apiError(500))).toBe("transient");
        expect(classifyAgentError(apiError(503))).toBe("transient");
        expect(classifyAgentError(apiError(529))).toBe("transient");
    });

    test("client-error API status codes classify as fatal", () => {
        expect(classifyAgentError(apiError(400))).toBe("fatal");
        expect(classifyAgentError(apiError(401))).toBe("fatal");
        expect(classifyAgentError(apiError(403))).toBe("fatal");
        expect(classifyAgentError(apiError(404))).toBe("fatal");
        expect(classifyAgentError(apiError(422))).toBe("fatal");
    });

    test("corrupted thought signature is transient despite the 400 status", () => {
        const err = new APICallError({
            message: "[Google AI Studio] Corrupted thought signature.",
            url: "https://openrouter.ai/api/v1/chat/completions",
            requestBodyValues: {},
            statusCode: 400,
            responseHeaders: {},
            responseBody: "",
        });
        expect(classifyAgentError(err)).toBe("transient");
    });

    test("corrupted thought signature is transient when wrapped in the cause chain", () => {
        const cause = new APICallError({
            message: "[Google AI Studio] Corrupted thought signature.",
            url: "https://openrouter.ai/api/v1/chat/completions",
            requestBodyValues: {},
            statusCode: 400,
            responseHeaders: {},
            responseBody: "",
        });
        const wrapped = new AgentError(
            'agent "kb-generator" (model google/gemini-3-flash-preview) failed: boom',
            "kb-generator",
            cause,
        );
        expect(classifyAgentError(wrapped)).toBe("transient");
    });

    test("network errors classify as transient", () => {
        expect(classifyAgentError(new Error("read ECONNRESET"))).toBe("transient");
        expect(classifyAgentError(new Error("fetch failed"))).toBe("transient");
        expect(classifyAgentError(new Error("socket hang up"))).toBe("transient");
    });

    test("unknown errors default to transient", () => {
        expect(classifyAgentError(new Error("something unexpected"))).toBe("transient");
        expect(classifyAgentError("plain string error")).toBe("transient");
    });
});

describe("formatException", () => {
    test("includes the stack trace", () => {
        const out = formatException(new Error("boom"));
        expect(out).toContain("Error: boom");
        expect(out).toContain("at "); // stack frames
    });

    test("includes the cause chain", () => {
        const cause = new Error("connect ECONNREFUSED 127.0.0.1:3000");
        const err = new Error("fetch failed", { cause });
        const out = formatException(err);
        expect(out).toContain("fetch failed");
        expect(out).toContain("Caused by:");
        expect(out).toContain("ECONNREFUSED");
    });

    test("stringifies non-Error values", () => {
        expect(formatException("plain failure")).toBe("plain failure");
    });
});

describe("describeKnownError", () => {
    function apiError(statusCode: number, message = `HTTP ${statusCode}`): APICallError {
        return new APICallError({
            message,
            url: "https://example.com",
            requestBodyValues: {},
            statusCode,
            responseHeaders: {},
            responseBody: "",
        });
    }

    test("recognizes the missing-auth-header failure", () => {
        const known = describeKnownError(new Error("Missing Authentication header"));
        expect(known?.title).toContain("API token");
        expect(known?.hint).toContain("AUTONOMA_API_TOKEN");
    });

    test("recognizes auth failures through the cause chain", () => {
        const wrapped = new AgentError(
            'agent "pagesFinder" (model x) failed: boom',
            "pagesFinder",
            new Error("No auth credentials found"),
        );
        expect(describeKnownError(wrapped)).not.toBeUndefined();
    });

    test("recognizes 401/403 by status code", () => {
        expect(describeKnownError(apiError(401))).not.toBeUndefined();
        expect(describeKnownError(apiError(403))).not.toBeUndefined();
    });

    test("recognizes out-of-credits and rate-limit failures", () => {
        expect(describeKnownError(apiError(402, "Insufficient credits"))?.title).toContain("credits");
        expect(describeKnownError(apiError(429))?.title).toContain("rate-limit");
    });

    test("maps an out-of-credits message to the Autonoma top-up hint", () => {
        const msg = "This request requires more credits. Insufficient credits.";
        const known = describeKnownError(new AgentError(`agent "kb" (model x) failed: ${msg}`, "kb", new Error(msg)));
        expect(known?.title).toContain("credit");
        expect(known?.hint).toContain("autonoma.app");
    });

    test("returns null for unrecognized errors", () => {
        expect(describeKnownError(new Error("something nobody has seen"))).toBeUndefined();
        expect(describeKnownError(apiError(500))).toBeUndefined();
    });
});

describe("isUserCancellation", () => {
    test("matches the cancellation errors thrown at interactive prompts", () => {
        expect(isUserCancellation(new Error("Entity loop cancelled"))).toBe(true);
        expect(isUserCancellation(new Error("Recipe review cancelled"))).toBe(true);
        expect(isUserCancellation(new Error("Cancelled"))).toBe(true);
        expect(isUserCancellation(new Error("operation was canceled"))).toBe(true);
    });

    test("does not match real failures or non-errors", () => {
        expect(isUserCancellation(new Error("Missing Authentication header"))).toBe(false);
        expect(isUserCancellation("cancelled")).toBe(false);
        expect(isUserCancellation(undefined)).toBe(false);
    });
});

describe("supportReference", () => {
    test("includes a ref and merges extra fields", () => {
        const ref = supportReference({ step: "pagesFinder" });
        expect(ref).toMatch(/ref: [0-9a-f-]{36}/);
        expect(ref).toContain("step: pagesFinder");
        expect(ref).toContain(`node: ${process.version}`);
    });

    test("omits empty fields", () => {
        expect(supportReference({ step: undefined })).not.toContain("step:");
    });
});

describe("AgentError", () => {
    test("has correct properties", () => {
        const err = new AgentError("failed", "kb-generator", new Error("cause"));
        expect(err.message).toBe("failed");
        expect(err.phase).toBe("kb-generator");
        expect(err.cause).toBeInstanceOf(Error);
        expect(err.name).toBe("AgentError");
    });
});

describe("ToolError", () => {
    test("has correct properties", () => {
        const err = new ToolError("read failed", "read_file");
        expect(err.message).toBe("read failed");
        expect(err.toolName).toBe("read_file");
        expect(err.name).toBe("ToolError");
    });
});
