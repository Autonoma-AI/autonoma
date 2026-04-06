import { randomBytes } from "node:crypto";
import {
    type Organization,
    type PrismaClient,
    type Session,
    type User,
    applyMigrations,
    createClient,
} from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import type { IntegrationHarness } from "@autonoma/integration-test";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { S3Storage } from "@autonoma/storage";
import { FakeGenerationProvider } from "@autonoma/test-updates";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { LocalstackContainer, type StartedLocalStackContainer } from "@testcontainers/localstack";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";
import { vi } from "vitest";
import { buildAuth } from "../src/auth";
import { type Services, buildServices } from "../src/routes/build-services";
import { appRouter } from "../src/routes/router";
import { t } from "../src/trpc";

const POSTGRES_IMAGE = "postgres:17-alpine";
const LOCALSTACK_IMAGE = "localstack/localstack:latest";
const REDIS_IMAGE = "redis:7-alpine";
const TEST_BUCKET = "test-bucket";
const TEST_REGION = "us-east-1";

export class APITestHarness implements IntegrationHarness {
    public readonly triggerWorkflow = vi.fn().mockResolvedValue(undefined);
    public readonly generationProvider: FakeGenerationProvider;
    public readonly services: Services;
    public organization?: Organization;
    public user?: User;
    public session?: Session;

    private pgContainer?: StartedPostgreSqlContainer;
    private lsContainer?: StartedLocalStackContainer;
    private redisContainer?: StartedRedisContainer;
    private redisClient?: Redis;

    constructor(
        public readonly db: PrismaClient,
        services: Services,
        generationProvider: FakeGenerationProvider,
        pgContainer: StartedPostgreSqlContainer,
        lsContainer: StartedLocalStackContainer,
        redisContainer: StartedRedisContainer,
        redisClient: Redis,
    ) {
        this.pgContainer = pgContainer;
        this.lsContainer = lsContainer;
        this.redisContainer = redisContainer;
        this.redisClient = redisClient;
        this.services = services;
        this.generationProvider = generationProvider;
    }

    static async create(): Promise<APITestHarness> {
        const [pgResult, lsResult, redisContainer] = await Promise.all([
            startPostgresContainer(),
            startLocalStackContainer(),
            new RedisContainer(REDIS_IMAGE).start(),
        ]);
        applyMigrations(pgResult.connectionUrl);
        const db = createClient(pgResult.connectionUrl);

        const redisClient = new Redis(redisContainer.getConnectionUrl());
        const auth = buildAuth({ redisClient, conn: db });

        const encryptionKey = randomBytes(32).toString("hex");
        const encryptionHelper = new EncryptionHelper(encryptionKey);
        const scenarioManager = new ScenarioManager(db, encryptionHelper);

        const triggerWorkflow = vi.fn().mockResolvedValue(undefined);
        const generationProvider = new FakeGenerationProvider();

        const services = buildServices({
            conn: db,
            auth,
            storageProvider: lsResult.storage,
            triggerPlanWorkflow: triggerWorkflow,
            triggerRunWorkflow: triggerWorkflow,
            scenarioManager,
            encryptionHelper,
            generationProvider,
            githubApp: {} as unknown as GitHubApp,
        });

        const harness = new APITestHarness(
            db,
            services,
            generationProvider,
            pgResult.container,
            lsResult.container,
            redisContainer,
            redisClient,
        );
        harness.triggerWorkflow = triggerWorkflow as typeof harness.triggerWorkflow;
        return harness;
    }

    async beforeAll() {
        this.organization = await this.db.organization.create({
            data: {
                name: "Test Organization",
                slug: "test-org",
            },
        });

        this.user = await this.db.user.create({
            data: {
                name: "Test User",
                email: "test@example.com",
                emailVerified: true,
            },
        });

        this.session = await this.db.session.create({
            data: {
                token: "test-session-token",
                expiresAt: new Date(Date.now() + 86400000),
                userId: this.user.id,
                activeOrganizationId: this.organization.id,
            },
        });
    }

    async afterAll() {
        await this.redisClient?.quit();
        await this.redisContainer?.stop();
        await this.pgContainer?.stop();
        await this.lsContainer?.stop();
    }

    async beforeEach() {}

    async afterEach() {}

    get organizationId(): string {
        if (this.organization == null) throw new Error("Harness not set up - call setup() first");
        return this.organization.id;
    }

    get userId(): string {
        if (this.user == null) throw new Error("Harness not set up - call setup() first");
        return this.user.id;
    }

    request(session?: Session) {
        const createCaller = t.createCallerFactory(appRouter);
        return createCaller({
            db: this.db,
            user: this.user,
            session: session ?? this.session,
            services: this.services,
        });
    }
}

async function startPostgresContainer() {
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    const connectionUrl = container.getConnectionUri();
    return { container, connectionUrl };
}

async function startLocalStackContainer() {
    const container = await new LocalstackContainer(LOCALSTACK_IMAGE).withEnvironment({ SERVICES: "s3" }).start();
    const endpoint = container.getConnectionUri();

    const s3Client = new S3Client({
        region: TEST_REGION,
        endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await s3Client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));

    const storage = new S3Storage({
        bucket: TEST_BUCKET,
        region: TEST_REGION,
        accessKeyId: "test",
        secretAccessKey: "test",
        endpoint,
    });

    return { container, storage };
}
