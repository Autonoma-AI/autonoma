import { randomBytes } from "node:crypto";
import { type Organization, type PrismaClient, type Session, type User, createQueryCountingClient } from "@autonoma/db";
import { FakeGitHubApp } from "@autonoma/github";
import type { IntegrationHarness } from "@autonoma/integration-test";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { LocalStorageProvider, S3Storage, type StorageProvider } from "@autonoma/storage";
import { FakeGenerationProvider } from "@autonoma/test-updates";
import type {
    PipelineWorkflows,
    TriggerAnalysisJobParams,
    TriggerDiffsJobParams,
    TriggerInvestigationJobParams,
} from "@autonoma/workflow";
import Redis from "ioredis";
import { type Mock, vi } from "vitest";
import { buildAuth } from "../src/auth";
import { type Services, buildServices } from "../src/routes/build-services";
import { appRouter } from "../src/routes/router";
import { t } from "../src/trpc";

/**
 * Test double for {@link PipelineWorkflows}: routes every operation to the shared `triggerWorkflow` spy, except
 * analysis (its own `triggerAnalysis` spy) so tests can assert analysis triggers without conflation.
 */
class FakePipelineWorkflows implements PipelineWorkflows {
    constructor(
        private readonly onWorkflow: Mock,
        private readonly onAnalysis: Mock,
    ) {}
    triggerDiffs(params: TriggerDiffsJobParams): Promise<void> {
        return this.onWorkflow(params);
    }
    cancelDiffs(snapshotId: string): Promise<void> {
        return this.onWorkflow(snapshotId);
    }
    triggerInvestigation(params: TriggerInvestigationJobParams): Promise<void> {
        return this.onWorkflow(params);
    }
    cancelInvestigation(snapshotId: string): Promise<void> {
        return this.onWorkflow(snapshotId);
    }
    triggerAnalysis(params: TriggerAnalysisJobParams): Promise<void> {
        return this.onAnalysis(params);
    }
    cancelAnalysis(snapshotId: string): Promise<void> {
        return this.onWorkflow(snapshotId);
    }
}

export class APITestHarness implements IntegrationHarness {
    public triggerWorkflow = vi.fn().mockResolvedValue(undefined);
    // Dedicated mock for the analysis pipeline trigger so tests can assert on its args (snapshotId + mode)
    // without them being conflated with the shared triggerWorkflow spy used by every other trigger.
    public triggerAnalysis = vi.fn().mockResolvedValue(undefined);
    public readonly generationProvider: FakeGenerationProvider;
    public readonly services: Services;
    public readonly githubApp: FakeGitHubApp;
    public organization?: Organization;
    public user?: User;
    public session?: Session;

    private redisClient: Redis;

    constructor(
        public readonly db: PrismaClient,
        services: Services,
        generationProvider: FakeGenerationProvider,
        redisClient: Redis,
        githubApp: FakeGitHubApp,
    ) {
        this.redisClient = redisClient;
        this.services = services;
        this.generationProvider = generationProvider;
        this.githubApp = githubApp;
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

        const db = createQueryCountingClient(dbUrl);
        const redisClient = new Redis(redisUrl);
        const auth = buildAuth({ redisClient, conn: db });

        const encryptionKey = randomBytes(32).toString("hex");
        const encryptionHelper = new EncryptionHelper(encryptionKey);
        const scenarioManager = new ScenarioManager(db, encryptionHelper);

        const triggerWorkflow = vi.fn().mockResolvedValue(undefined);
        const triggerAnalysis = vi.fn().mockResolvedValue(undefined);
        const generationProvider = new FakeGenerationProvider();

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

        const githubApp = new FakeGitHubApp();

        const services = buildServices({
            conn: db,
            auth,
            storageProvider: storage,
            scenarioManager,
            encryptionHelper,
            getVercelEncryptionHelper: () => encryptionHelper,
            generationProvider,
            githubApp,
            pipelineWorkflows: new FakePipelineWorkflows(triggerWorkflow, triggerAnalysis),
            triggerPreviewDeploy: triggerWorkflow,
            triggerPreviewTeardown: triggerWorkflow,
            triggerPreviewRedeployApp: triggerWorkflow,
        });

        const harness = new APITestHarness(db, services, generationProvider, redisClient, githubApp);
        harness.triggerWorkflow = triggerWorkflow as typeof harness.triggerWorkflow;
        harness.triggerAnalysis = triggerAnalysis;
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
