import { beforeEach, describe, expect, it, vi } from "vitest";

const { s3ClientConfigs } = vi.hoisted(() => ({
    s3ClientConfigs: [] as unknown[],
}));

vi.mock("@aws-sdk/client-s3", () => ({
    DeleteObjectCommand: class {},
    GetObjectCommand: class {},
    PutObjectCommand: class {},
    S3Client: class {
        public readonly config: unknown;

        constructor(config: unknown) {
            this.config = config;
            s3ClientConfigs.push(config);
        }

        send() {
            return Promise.resolve({});
        }
    },
}));

vi.mock("@aws-sdk/lib-storage", () => ({
    Upload: class {
        done() {
            return Promise.resolve();
        }
    },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
    getSignedUrl: vi.fn(),
}));

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

describe("S3Storage.createFromEnv", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
        clearStorageEnv();
        s3ClientConfigs.length = 0;
        stubRequiredStorageEnv();
    });

    it("uses the default AWS client configuration when S3_ENDPOINT is unset", async () => {
        const { S3Storage } = await import("./s3-storage");

        const storage = S3Storage.createFromEnv();

        expect(storage).toBeInstanceOf(S3Storage);
        expect(s3ClientConfigs).toHaveLength(1);
        expect(s3ClientConfigs[0]).toEqual({
            region: "us-east-1",
            credentials: {
                accessKeyId: "minioadmin",
                secretAccessKey: "minioadmin",
            },
        });
    });

    it("passes S3_ENDPOINT through and enables path-style addressing", async () => {
        vi.stubEnv("S3_ENDPOINT", "http://localhost:9000");

        const { S3Storage } = await import("./s3-storage");

        const storage = S3Storage.createFromEnv();

        expect(storage).toBeInstanceOf(S3Storage);
        expect(s3ClientConfigs).toHaveLength(1);
        expect(s3ClientConfigs[0]).toEqual({
            region: "us-east-1",
            credentials: {
                accessKeyId: "minioadmin",
                secretAccessKey: "minioadmin",
            },
            endpoint: "http://localhost:9000",
            forcePathStyle: true,
        });
    });
});
