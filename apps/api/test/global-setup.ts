import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { LocalstackContainer } from "@testcontainers/localstack";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";

const POSTGRES_IMAGE = "postgres:17-alpine";
const LOCALSTACK_IMAGE = "localstack/localstack:latest";
const REDIS_IMAGE = "redis:7-alpine";
const TEST_BUCKET = "test-bucket";
const TEST_REGION = "us-east-1";

let teardownFns: (() => Promise<void>)[] = [];

export async function setup(): Promise<void> {
    // Set TESTING before any @autonoma/* imports so createEnv skips validation
    process.env.TESTING = "true";

    const useCI = process.env.CI_DATABASE_URL != null && process.env.CI_REDIS_URL != null;

    if (useCI) {
        await setupCI();
    } else {
        await setupTestcontainers();
    }
}

/** CI: use GitHub Actions service containers + local filesystem for storage. */
async function setupCI(): Promise<void> {
    const pgUrl = process.env.CI_DATABASE_URL!;
    const { applyMigrations } = await import("@autonoma/db");
    applyMigrations(pgUrl);

    process.env.TEST_DATABASE_URL = pgUrl;
    process.env.TEST_REDIS_URL = process.env.CI_REDIS_URL!;
    // Signal harness to use LocalStorageProvider instead of S3
    process.env.TEST_STORAGE_DIR = mkdtempSync(join(tmpdir(), "api-test-"));
}

/** Local: spin up Testcontainers for PostgreSQL, Redis, and LocalStack. */
async function setupTestcontainers(): Promise<void> {
    const [pgContainer, lsContainer, redisContainer] = await Promise.all([
        new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(120_000).start(),
        new LocalstackContainer(LOCALSTACK_IMAGE)
            .withEnvironment({ SERVICES: "s3" })
            .withStartupTimeout(120_000)
            .start(),
        new RedisContainer(REDIS_IMAGE).withStartupTimeout(120_000).start(),
    ]);

    const pgUrl = pgContainer.getConnectionUri();
    const { applyMigrations } = await import("@autonoma/db");
    applyMigrations(pgUrl);

    const lsEndpoint = lsContainer.getConnectionUri();
    const s3Client = new S3Client({
        region: TEST_REGION,
        endpoint: lsEndpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await s3Client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));

    process.env.TEST_DATABASE_URL = pgUrl;
    process.env.TEST_REDIS_URL = redisContainer.getConnectionUrl();
    process.env.TEST_S3_ENDPOINT = lsEndpoint;
    process.env.TEST_S3_BUCKET = TEST_BUCKET;
    process.env.TEST_S3_REGION = TEST_REGION;

    teardownFns = [
        async () => {
            await redisContainer.stop();
        },
        async () => {
            await pgContainer.stop();
        },
        async () => {
            await lsContainer.stop();
        },
    ];
}

export async function teardown(): Promise<void> {
    await Promise.allSettled(teardownFns.map((fn) => fn()));
}
