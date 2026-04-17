import { randomBytes } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import {
    type PrismaClient,
    type ScenarioInstanceStatus,
    SnapshotStatus,
    applyMigrations,
    createClient,
} from "@autonoma/db";
import type { IntegrationHarness } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { EncryptionHelper } from "../src/encryption";
import { ScenarioRecipeStore } from "../src/scenario-recipe-store";

export class WebhookServer {
    private readonly server: Server;
    private handler: (req: IncomingMessage, body: unknown) => { status: number; body: unknown } = () => ({
        status: 200,
        body: {},
    });
    public readonly requests: Array<{ method: string; body: unknown; headers: Record<string, string | undefined> }> =
        [];
    public port = 0;

    constructor() {
        this.server = createServer((req, res) => {
            this.readBody(req).then((body) => {
                this.requests.push({
                    method: req.method ?? "GET",
                    body,
                    headers: req.headers as Record<string, string | undefined>,
                });
                const result = this.handler(req, body);
                res.writeHead(result.status, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result.body));
            });
        });
    }

    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.server.listen(0, () => {
                const addr = this.server.address();
                if (addr != null && typeof addr === "object") {
                    this.port = addr.port;
                }
                resolve();
            });
        });
    }

    get url(): string {
        return `http://localhost:${this.port}/webhook`;
    }

    onRequest(handler: (req: IncomingMessage, body: unknown) => { status: number; body: unknown }): void {
        this.handler = handler;
    }

    reset(): void {
        this.requests.length = 0;
        this.handler = () => ({ status: 200, body: {} });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            this.server.close(() => resolve());
        });
    }

    private readBody(req: IncomingMessage): Promise<unknown> {
        return new Promise((resolve) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                try {
                    resolve(JSON.parse(raw));
                } catch {
                    resolve(raw);
                }
            });
        });
    }
}

const POSTGRES_IMAGE = "postgres:17-alpine";

export class ScenarioTestHarness implements IntegrationHarness {
    public readonly db: PrismaClient;
    public readonly encryption: EncryptionHelper;
    public readonly encryptionKey: string;
    public readonly webhookServer: WebhookServer;

    private pgContainer: StartedPostgreSqlContainer;

    constructor(db: PrismaClient, pgContainer: StartedPostgreSqlContainer, webhookServer: WebhookServer) {
        this.db = db;
        this.pgContainer = pgContainer;
        this.webhookServer = webhookServer;
        this.encryptionKey = randomBytes(32).toString("hex");
        this.encryption = new EncryptionHelper(this.encryptionKey);
    }

    static async create(): Promise<ScenarioTestHarness> {
        const webhookServer = new WebhookServer();
        const [pgContainer] = await Promise.all([
            new PostgreSqlContainer(POSTGRES_IMAGE).start(),
            webhookServer.start(),
        ]);
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new ScenarioTestHarness(db, pgContainer, webhookServer);
    }

    async beforeAll() {
        // No-op - harness is ready after create()
    }

    async afterAll() {
        await this.webhookServer.stop();
        await this.pgContainer.stop();
    }

    async beforeEach() {
        this.webhookServer.reset();
        await this.db.webhookCall.deleteMany();
    }

    async afterEach(): Promise<void> {
        // No-op
    }

    async createOrg(): Promise<string> {
        const date = Date.now();

        const org = await this.db.organization.create({
            data: {
                name: `Test Org ${date}`,
                slug: `test-org-${date}`,
            },
        });
        return org.id;
    }

    async createApp(
        organizationId: string,
        opts?: { webhookUrl?: string; signingSecret?: string },
    ): Promise<{ appId: string; deploymentId: string }> {
        const signingSecretEnc = opts?.signingSecret != null ? this.encryption.encrypt(opts.signingSecret) : undefined;

        const date = Date.now();
        const app = await this.db.application.create({
            data: {
                name: `App ${date}`,
                slug: `app-${date}`,
                organizationId,
                architecture: "WEB",
                signingSecretEnc,
            },
        });

        const branch = await this.db.branch.create({
            data: { name: "main", applicationId: app.id, organizationId },
        });

        const deployment = await this.db.branchDeployment.create({
            data: {
                branchId: branch.id,
                organizationId,
                webhookUrl: opts?.webhookUrl,
                active: true,
            },
        });

        const snapshot = await this.db.branchSnapshot.create({
            data: {
                branchId: branch.id,
                source: "MANUAL",
                status: SnapshotStatus.active,
            },
        });

        await this.db.branch.update({
            where: { id: branch.id },
            data: { deploymentId: deployment.id, activeSnapshotId: snapshot.id },
        });

        await this.db.application.update({
            where: { id: app.id },
            data: { mainBranchId: branch.id },
        });

        return { appId: app.id, deploymentId: deployment.id };
    }

    async createScenario(
        organizationId: string,
        applicationId: string,
        name: string,
        recipe?: Record<string, unknown>,
    ): Promise<string> {
        if (recipe != null) {
            const snapshotId = await this.getMainBranchSnapshotId(applicationId);
            const store = new ScenarioRecipeStore(this.db);
            await store.replaceScenarioRecipes({
                snapshotId,
                applicationId,
                organizationId,
                recipesFile: {
                    version: 1,
                    source: {
                        discoverPath: "autonoma/discover.json",
                        scenariosPath: "autonoma/scenarios.md",
                    },
                    validationMode: "sdk-check",
                    recipes: [
                        {
                            name,
                            description: name,
                            create: recipe,
                            validation: { status: "validated", method: "checkScenario", phase: "ok" },
                        },
                    ],
                },
            });
            const scenario = await this.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId, name } },
                select: { id: true },
            });
            return scenario.id;
        }

        const scenario = await this.db.scenario.create({
            data: { organizationId, applicationId, name },
        });
        return scenario.id;
    }

    async getMainBranchSnapshotId(applicationId: string): Promise<string> {
        const application = await this.db.application.findUniqueOrThrow({
            where: { id: applicationId },
            select: {
                mainBranch: {
                    select: {
                        activeSnapshotId: true,
                    },
                },
            },
        });

        const snapshotId = application.mainBranch?.activeSnapshotId;
        if (snapshotId == null) {
            throw new Error(`Application ${applicationId} has no active main-branch snapshot`);
        }

        return snapshotId;
    }

    async createSetupWithArtifacts(
        organizationId: string,
        applicationId: string,
        artifacts: Array<{ path: string; content: string }>,
    ): Promise<string> {
        const date = Date.now();
        const user = await this.db.user.create({
            data: {
                name: `Scenario Harness User ${date}`,
                email: `scenario-harness-${date}-${randomBytes(4).toString("hex")}@example.com`,
                emailVerified: true,
            },
        });

        const setup = await this.db.applicationSetup.create({
            data: {
                applicationId,
                organizationId,
                userId: user.id,
                totalSteps: 5,
            },
        });

        if (artifacts.length > 0) {
            await this.db.applicationSetupArtifact.createMany({
                data: artifacts.map((artifact) => ({
                    setupId: setup.id,
                    applicationId,
                    organizationId,
                    path: artifact.path,
                    content: artifact.content,
                })),
            });
        }

        return setup.id;
    }

    async createGeneration(
        organizationId: string,
        applicationId: string,
        deploymentId: string,
        scenarioId?: string,
    ): Promise<string> {
        const app = await this.db.application.findUniqueOrThrow({
            where: { id: applicationId },
            select: { mainBranchId: true },
        });

        const branchId = app.mainBranchId!;
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId, source: "MANUAL", status: SnapshotStatus.processing },
        });
        const testCase = await this.db.testCase.create({
            data: {
                name: `Test Case ${Date.now()}`,
                slug: `test-case-${Date.now()}`,
                applicationId,
                organizationId,
            },
        });
        const testPlan = await this.db.testPlan.create({
            data: {
                prompt: "test prompt",
                testCaseId: testCase.id,
                organizationId,
                scenarioId,
            },
        });
        const generation = await this.db.testGeneration.create({
            data: {
                testPlanId: testPlan.id,
                snapshotId: snapshot.id,
                organizationId,
                status: "pending",
                conversation: [],
            },
        });
        return generation.id;
    }

    async createScenarioInstance(
        organizationId: string,
        applicationId: string,
        scenarioName: string,
        status: ScenarioInstanceStatus,
    ): Promise<string> {
        const scenario = await this.db.scenario.create({
            data: { organizationId, applicationId, name: scenarioName },
        });
        const instance = await this.db.scenarioInstance.create({
            data: {
                organizationId,
                applicationId,
                scenarioId: scenario.id,
                status,
            },
        });
        return instance.id;
    }
}
