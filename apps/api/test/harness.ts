import { randomBytes } from "node:crypto";
import { ensureBillingProvisioning } from "@autonoma/billing";
import { type Organization, type PrismaClient, type Session, type User, createQueryCountingClient } from "@autonoma/db";
import { FakeGitHubApp } from "@autonoma/github";
import { type IntegrationHarness, createTestDatabase } from "@autonoma/integration-test";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { S3Storage, type StorageProvider } from "@autonoma/storage";
import type { TriggerBatchGenerationParams, WorkflowRef } from "@autonoma/workflow";
import Redis from "ioredis";
import { vi } from "vitest";
import { type Auth, buildAuth } from "../src/auth";
import type { EmailSender, OutgoingEmail } from "../src/email/email-sender";
import { env } from "../src/env";
import { type Services, buildServices } from "../src/routes/build-services";
import { appRouter } from "../src/routes/router";
import { t } from "../src/trpc";

/**
 * Records every email a service tried to send instead of dialling a provider, and can be told
 * to fail so a caller's behaviour when mail delivery breaks is observable.
 */
export class RecordingEmailSender implements EmailSender {
    public readonly sent: OutgoingEmail[] = [];
    public failNextSend = false;

    async send(email: OutgoingEmail): Promise<void> {
        if (this.failNextSend) {
            this.failNextSend = false;
            throw new Error("Simulated mail provider failure");
        }
        this.sent.push(email);
    }
}

/**
 * Typed so a test reading `mock.lastCall` gets the real params back rather than `any` - the spy is the only
 * place the batch a dispatch handed over is observable.
 */
function fakeStartGenerationBatch() {
    return vi
        .fn<(params: TriggerBatchGenerationParams) => Promise<WorkflowRef>>()
        .mockResolvedValue({ workflowId: "", runId: "" });
}

export class APITestHarness implements IntegrationHarness {
    public triggerWorkflow = vi.fn().mockResolvedValue(undefined);
    /**
     * Spy on the analysis-run trigger, so a test can assert what a caller asked for. The run itself opens inside
     * the workflow, so this is the only place the API's decision is observable.
     */
    public startAnalysisRun = vi.fn().mockResolvedValue(undefined);
    /** Spy on the generation-batch dispatch, so a test can assert which runs the editor handed to the fleet. */
    public startGenerationBatch = fakeStartGenerationBatch();
    public readonly services: Services;
    public readonly githubApp: FakeGitHubApp;
    public readonly emailSender: RecordingEmailSender;
    /**
     * The same better-auth instance the router is built with, so a test can create a real session
     * through `internalAdapter` instead of hand-writing rows into the two places one lives.
     */
    public readonly auth: Auth;
    /**
     * The same ScenarioManager the services are built with, so a test constructing a service by hand
     * gets the SDK seam the router has rather than a second one wired to a different encryption key.
     */
    public readonly scenarioManager: ScenarioManager;
    /**
     * The bare domain the internal organization is keyed on, read from the same env the services use -
     * so a test about internal-vs-customer precedence cannot disagree with the code under test.
     */
    public readonly internalDomain: string = env.INTERNAL_DOMAIN;
    /**
     * The sender invitations go out as, read from the same env the services use so a test cannot
     * disagree with the code about what it should be.
     */
    public readonly invitesFromEmail: string = env.RESEND_INVITES_FROM_EMAIL;
    public organization?: Organization;
    public user?: User;
    public session?: Session;

    private redisClient: Redis;

    constructor(
        public readonly db: PrismaClient,
        services: Services,
        redisClient: Redis,
        githubApp: FakeGitHubApp,
        emailSender: RecordingEmailSender,
        auth: Auth,
        scenarioManager: ScenarioManager,
    ) {
        this.redisClient = redisClient;
        this.services = services;
        this.githubApp = githubApp;
        this.emailSender = emailSender;
        this.auth = auth;
        this.scenarioManager = scenarioManager;
    }

    static async create(): Promise<APITestHarness> {
        // This suite's own database, forked from the migrated template - so a suite can create an
        // organization, delete rows or leave state behind without any other suite observing it, and
        // suites can therefore run in parallel.
        const dbUrl = await createTestDatabase();
        const redisUrl = process.env.TEST_REDIS_URL;
        const s3Endpoint = process.env.TEST_S3_ENDPOINT;
        const s3Bucket = process.env.TEST_S3_BUCKET;
        const s3Region = process.env.TEST_S3_REGION;

        if (redisUrl == null || s3Endpoint == null || s3Bucket == null || s3Region == null) {
            throw new Error(
                "TEST_REDIS_URL and TEST_S3_* must be set. " +
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
        const startAnalysisRun = vi.fn().mockResolvedValue(undefined);
        const startGenerationBatch = fakeStartGenerationBatch();

        const storage: StorageProvider = new S3Storage({
            bucket: s3Bucket,
            region: s3Region,
            accessKeyId: "test",
            secretAccessKey: "test",
            endpoint: s3Endpoint,
        });

        const githubApp = new FakeGitHubApp();
        const emailSender = new RecordingEmailSender();

        const services = buildServices({
            conn: db,
            auth,
            redisClient,
            storageProvider: storage,
            scenarioManager,
            encryptionHelper,
            getVercelEncryptionHelper: () => encryptionHelper,
            githubApp,
            startAnalysisRun,
            startGenerationBatch,
            startPreviewBuild: triggerWorkflow,
            triggerPreviewTeardown: triggerWorkflow,
            triggerPreviewRedeployApp: triggerWorkflow,
            emailSender,
        });

        const harness = new APITestHarness(db, services, redisClient, githubApp, emailSender, auth, scenarioManager);
        harness.triggerWorkflow = triggerWorkflow as typeof harness.triggerWorkflow;
        harness.startAnalysisRun = startAnalysisRun;
        harness.startGenerationBatch = startGenerationBatch;
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

        // The same provisioning every real organization gets on its first sign-in
        // (`ensureOrgMembership`), which is what grants the free starting credits. Without it the
        // harness org sits at a zero balance no real one ever has, and any flow behind the credits
        // gate - queueing generations, triggering a preview - fails on "Insufficient credits".
        await ensureBillingProvisioning(this.db, this.organization.id, { grantFreeStart: true });
    }

    async afterAll() {
        await this.redisClient?.quit();
        // Hand the pool back rather than leaving it to the container teardown. A worker runs several
        // suites in sequence, so an undisconnected client per suite accumulates idle connections in
        // one process - and with suites now running in parallel, the server's max_connections is a
        // shared ceiling every worker draws on.
        await this.db.$disconnect();
    }

    async beforeEach() {}

    async afterEach() {}

    get organizationId(): string {
        if (this.organization == null) throw new Error("Harness not set up - call setup() first");
        return this.organization.id;
    }

    /**
     * Gives an application a preview topology naming `appNames`, and answers with
     * name -> app row id.
     *
     * Secrets, app instances and app builds all hang off the app row, so a test that
     * seeds any of them needs the topology first - there is nowhere else for those
     * rows to point. Returning the ids lets a caller write an instance or build
     * directly without looking them up again.
     */
    async seedTopology(applicationId: string, appNames: readonly string[]): Promise<Map<string, string>> {
        const config = await this.db.previewkitConfig.upsert({
            where: { applicationId },
            create: { applicationId },
            update: {},
            select: { id: true },
        });

        const ids = new Map<string, string>();
        for (const [position, name] of appNames.entries()) {
            const app = await this.db.previewkitApp.upsert({
                where: { configId_name: { configId: config.id, name } },
                create: {
                    configId: config.id,
                    position,
                    name,
                    repository: "acme/web",
                    path: ".",
                    port: 3000,
                    resourcesTier: "medium",
                },
                update: {},
                select: { id: true },
            });
            ids.set(name, app.id);
        }
        return ids;
    }

    get userId(): string {
        if (this.user == null) throw new Error("Harness not set up - call setup() first");
        return this.user.id;
    }

    /**
     * A caller for the harness user, or for `user`/`session` when acting as somebody else -
     * needed wherever a flow spans two accounts, e.g. one member inviting another.
     */
    request(session?: Session, user?: User) {
        const createCaller = t.createCallerFactory(appRouter);
        return createCaller({
            db: this.db,
            user: user ?? this.user,
            session: session ?? this.session,
            services: this.services,
        });
    }
}
