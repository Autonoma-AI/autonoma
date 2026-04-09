import { randomBytes } from "node:crypto";
import { type Organization, type PrismaClient, type Session, type User, createClient } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import type { IntegrationHarness } from "@autonoma/integration-test";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { LocalStorageProvider, S3Storage, type StorageProvider } from "@autonoma/storage";
import { CommitDiffHandler, FakeGenerationProvider } from "@autonoma/test-updates";
import Redis from "ioredis";
import { vi } from "vitest";
import { buildAuth } from "../src/auth";
import { type Services, buildServices } from "../src/routes/build-services";
import { appRouter } from "../src/routes/router";
import { t } from "../src/trpc";

export class APITestHarness implements IntegrationHarness {
    public triggerWorkflow = vi.fn().mockResolvedValue(undefined);
    public readonly generationProvider: FakeGenerationProvider;
    public readonly services: Services;
    public organization?: Organization;
    public user?: User;
    public session?: Session;

    private redisClient: Redis;

    constructor(
        public readonly db: PrismaClient,
        services: Services,
        generationProvider: FakeGenerationProvider,
        redisClient: Redis,
    ) {
        this.redisClient = redisClient;
        this.services = services;
        this.generationProvider = generationProvider;
    }

    static async create(): Promise<APITestHarness> {
        const dbUrl = process.env.TEST_DATABASE_URL;
        const redisUrl = process.env.TEST_REDIS_URL;
        const s3Endpoint = process.env.TEST_S3_ENDPOINT;
        const s3Bucket = process.env.TEST_S3_BUCKET!;
        const s3Region = process.env.TEST_S3_REGION!;

        if (dbUrl == null || redisUrl == null) {
            throw new Error(
                "TEST_DATABASE_URL and TEST_REDIS_URL must be set. " +
                    "Run via vitest.integration.config.ts which uses globalSetup to start containers.",
            );
        }

        const db = createClient(dbUrl);
        const redisClient = new Redis(redisUrl);
        const auth = buildAuth({ redisClient, conn: db });

        const encryptionKey = randomBytes(32).toString("hex");
        const encryptionHelper = new EncryptionHelper(encryptionKey);
        const scenarioManager = new ScenarioManager(db, encryptionHelper);

        const triggerWorkflow = vi.fn().mockResolvedValue(undefined);
        const generationProvider = new FakeGenerationProvider();

        vi.spyOn(CommitDiffHandler.prototype, "checkForChanges").mockResolvedValue(undefined);

        const storageDir = process.env.TEST_STORAGE_DIR;
        const storage: StorageProvider =
            storageDir != null
                ? new LocalStorageProvider(storageDir)
                : new S3Storage({
                      bucket: s3Bucket,
                      region: s3Region,
                      accessKeyId: "test",
                      secretAccessKey: "test",
                      endpoint: s3Endpoint!,
                  });

        const services = buildServices({
            conn: db,
            auth,
            storageProvider: storage,
            triggerRunWorkflow: triggerWorkflow,
            triggerGenerationReview: triggerWorkflow,
            triggerRunReview: triggerWorkflow,
            triggerDiffPlanner: triggerWorkflow,
            scenarioManager,
            encryptionHelper,
            generationProvider,
            githubApp: {} as unknown as GitHubApp,
        });

        const harness = new APITestHarness(db, services, generationProvider, redisClient);
        harness.triggerWorkflow = triggerWorkflow as typeof harness.triggerWorkflow;
        return harness;
    }

    async beforeAll() {
        this.organization = await this.db.organization.create({
            data: {
                name: "Test Organization",
                slug: `test-org-${randomBytes(4).toString("hex")}`,
            },
        });

        this.user = await this.db.user.create({
            data: {
                name: "Test User",
                email: `test-${randomBytes(4).toString("hex")}@example.com`,
                emailVerified: true,
            },
        });

        this.session = await this.db.session.create({
            data: {
                token: `test-session-${randomBytes(8).toString("hex")}`,
                expiresAt: new Date(Date.now() + 86400000),
                userId: this.user.id,
                activeOrganizationId: this.organization.id,
            },
        });
    }

    async afterAll() {
        await this.redisClient?.quit();
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
