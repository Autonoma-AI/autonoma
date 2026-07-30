import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function clearStorageEnv() {
    delete process.env.S3_BUCKET;
    delete process.env.S3_REGION;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_ENDPOINT;
}

function stubRequiredStorageEnv() {
    vi.stubEnv("S3_BUCKET", "autonoma-local");
    vi.stubEnv("S3_REGION", "us-east-1");
    vi.stubEnv("S3_ACCESS_KEY_ID", "minioadmin");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "minioadmin");
}

describe("storage env", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
        clearStorageEnv();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        clearStorageEnv();
    });

    it("accepts an optional S3_ENDPOINT", async () => {
        stubRequiredStorageEnv();
        vi.stubEnv("S3_ENDPOINT", "http://localhost:9000");

        const { env } = await import("./env");

        expect(env.S3_ENDPOINT).toBe("http://localhost:9000");
    });

    it("continues to require the core S3 variables", async () => {
        clearStorageEnv();
        vi.stubEnv("S3_REGION", "us-east-1");
        vi.stubEnv("S3_ACCESS_KEY_ID", "minioadmin");
        vi.stubEnv("S3_SECRET_ACCESS_KEY", "minioadmin");

        await expect(import("./env")).rejects.toThrow("Invalid environment variables");
    });
});
