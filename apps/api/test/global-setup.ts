import { startSharedPostgres } from "@autonoma/integration-test";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { LocalstackContainer } from "@testcontainers/localstack";
import { RedisContainer } from "@testcontainers/redis";

const MINISTACK_IMAGE = "ministackorg/ministack:1.4.7";
const REDIS_IMAGE = "redis:7-alpine";
const TEST_BUCKET = "test-bucket";
const TEST_REGION = "us-east-1";
const CONTAINER_STARTUP_TIMEOUT_MS = 120_000;

let teardownFns: (() => Promise<void>)[] = [];

/**
 * One Postgres, one Redis and one S3 emulator for the whole run. Each suite forks its own
 * database from the migrated template (see `APITestHarness.create`), so suites can run in
 * parallel without seeing each other's rows.
 */
export async function setup(): Promise<void> {
    // Set TESTING before any @autonoma/* imports so createEnv skips validation
    process.env.TESTING = "true";
    const { applyMigrations } = await import("@autonoma/db");

    const [shared, msContainer, redisContainer] = await Promise.all([
        startSharedPostgres({ migrate: applyMigrations }),
        new LocalstackContainer(MINISTACK_IMAGE)
            .withEnvironment({ SERVICES: "s3" })
            .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
            .start(),
        new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS).start(),
    ]);

    const msEndpoint = msContainer.getConnectionUri();
    const s3Client = new S3Client({
        region: TEST_REGION,
        endpoint: msEndpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await s3Client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));

    process.env.TEST_REDIS_URL = redisContainer.getConnectionUrl();
    process.env.TEST_S3_ENDPOINT = msEndpoint;
    process.env.TEST_S3_BUCKET = TEST_BUCKET;
    process.env.TEST_S3_REGION = TEST_REGION;

    teardownFns = [
        async () => {
            await redisContainer.stop();
        },
        shared.stop,
        async () => {
            await msContainer.stop();
        },
    ];
}

export async function teardown(): Promise<void> {
    await Promise.allSettled(teardownFns.map((fn) => fn()));
}
