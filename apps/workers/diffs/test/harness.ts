import {
    type GenerationStatus,
    type Prisma,
    type PrismaClient,
    type ScenarioInstanceStatus,
    applyMigrations,
    createClient,
} from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import type { StorageProvider } from "@autonoma/storage";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { ModelMessage } from "ai";
import type { TestAPI } from "vitest";

const POSTGRES_IMAGE = "postgres:18-alpine";

/**
 * Minimal in-memory {@link StorageProvider} for the loader's generation path:
 * the generation conversation is the one piece of evidence the loader resolves
 * eagerly (from S3 in production), so the integration test serves it from this
 * map keyed by the `conversationUrl` the seeded generation points at. Every
 * other method throws - the loader never touches them.
 */
export class InMemoryStorage implements StorageProvider {
    private readonly objects = new Map<string, Buffer>();

    put(key: string, data: Buffer): void {
        this.objects.set(key, data);
    }

    async download(key: string): Promise<Buffer> {
        const data = this.objects.get(key);
        if (data == null) throw new Error(`InMemoryStorage: no object at key ${key}`);
        return data;
    }

    upload(): Promise<string> {
        throw new Error("InMemoryStorage.upload is not supported");
    }
    uploadStream(): Promise<string> {
        throw new Error("InMemoryStorage.uploadStream is not supported");
    }
    delete(): Promise<void> {
        throw new Error("InMemoryStorage.delete is not supported");
    }
    getSignedUrl(): Promise<string> {
        throw new Error("InMemoryStorage.getSignedUrl is not supported");
    }
}

/**
 * A scenario to attach to a seeded run/generation. `status` defaults to
 * `UP_SUCCESS`; omit `generatedData` for a pre-#822 instance. `upWebhookCreate`
 * additionally records an `UP` `webhook_call` carrying that create graph.
 */
export interface SeedScenario {
    name: string;
    status?: ScenarioInstanceStatus;
    generatedData?: unknown;
    upWebhookCreate?: Prisma.InputJsonValue;
}

/**
 * One generation attempt, materialized as a `StepAttempt` row (the timeline the
 * loader reads). A success carries `output`; a failure carries `error` +
 * `errorName` and omits `output`. `status` defaults to `"success"`.
 */
export interface SeedGenerationStep {
    order: number;
    interaction: string;
    params?: object;
    status?: "success" | "failed";
    output?: object;
    error?: string;
    errorName?: string;
    screenshotBefore?: string;
    screenshotAfter?: string;
}

export interface SeedGenerationParams {
    organizationId: string;
    applicationId: string;
    /** When omitted, the snapshot is created without SHAs (exercises the SHA-missing path). */
    baseSha?: string;
    headSha?: string;
    /** Defaults to "failed". */
    status?: GenerationStatus;
    reasoning?: string;
    testName?: string;
    testPlanPrompt?: string;
    /** When provided, the conversation JSON is stored in the harness storage and `conversationUrl` points at it. */
    conversation?: ModelMessage[];
    videoUrl?: string;
    finalScreenshot?: string;
    /** Attempt-timeline steps, materialized as `StepAttempt` rows (the preferred source). */
    steps?: SeedGenerationStep[];
    /**
     * Legacy replay-list steps, materialized as `StepInput`/`StepOutput` rows with
     * NO `StepAttempt`, exercising the loader's fallback for generations that
     * predate the attempt timeline. Every entry is treated as a success.
     */
    legacyStepInputs?: SeedGenerationStep[];
    /** When provided, a Scenario + ScenarioInstance is created and the generation is linked to it. */
    scenario?: SeedScenario;
}

export interface SeededGeneration {
    generationId: string;
    snapshotId: string;
    testCaseId: string;
    planId: string;
}

let testSeq = 0;
function uniqueSuffix(): string {
    testSeq += 1;
    return `${testSeq}-${Math.floor(performance.now())}`;
}

export class DiffJobContextHarness implements IntegrationHarness {
    public readonly db: PrismaClient;
    /** Serves the seeded generation conversation the loader downloads eagerly. */
    public readonly storage = new InMemoryStorage();

    private readonly pgContainer: StartedPostgreSqlContainer;

    constructor(db: PrismaClient, pgContainer: StartedPostgreSqlContainer) {
        this.db = db;
        this.pgContainer = pgContainer;
    }

    static async create(): Promise<DiffJobContextHarness> {
        const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new DiffJobContextHarness(db, pgContainer);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pgContainer.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    async createOrg(): Promise<string> {
        const suffix = uniqueSuffix();
        const org = await this.db.organization.create({
            data: { name: `Test Org ${suffix}`, slug: `test-org-${suffix}` },
        });
        return org.id;
    }

    async createApp(organizationId: string): Promise<string> {
        const suffix = uniqueSuffix();
        const app = await this.db.application.create({
            data: { name: `App ${suffix}`, slug: `app-${suffix}`, organizationId, architecture: "WEB" },
        });
        return app.id;
    }

    /**
     * Create a Scenario + ScenarioInstance as the manager does at UP success.
     * When `upWebhookCreate` is set, also records the `UP` `webhook_call` so the
     * webhook-recovery path can be tested against an instance with no
     * `generatedData`. Returns the instance id.
     */
    private async createScenarioInstance(
        organizationId: string,
        applicationId: string,
        scenario: SeedScenario,
    ): Promise<string> {
        const created = await this.db.scenario.create({
            data: { name: scenario.name, applicationId, organizationId },
        });
        const instance = await this.db.scenarioInstance.create({
            data: {
                scenarioId: created.id,
                applicationId,
                organizationId,
                status: scenario.status ?? "UP_SUCCESS",
                generatedData: scenario.generatedData ?? undefined,
            },
        });

        if (scenario.upWebhookCreate !== undefined) {
            await this.db.webhookCall.create({
                data: {
                    applicationId,
                    instanceId: instance.id,
                    action: "UP",
                    requestBody: { action: "up", create: scenario.upWebhookCreate, testRunId: instance.id },
                    responseBody: { instanceId: instance.id },
                    statusCode: 200,
                },
            });
        }

        return instance.id;
    }

    /** Create a bare branch + snapshot, returning the snapshot id. */
    async createSnapshot(organizationId: string, applicationId: string): Promise<string> {
        const suffix = uniqueSuffix();
        const branch = await this.db.branch.create({
            data: { name: `branch-${suffix}`, organizationId, applicationId },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "MANUAL" },
        });
        return snapshot.id;
    }

    /**
     * Seed a Scenario plus its point-in-time `ScenarioRecipeVersion` for a
     * snapshot - the artifact the recipe resolver reads. The recipe's declared
     * `create` graph is passed verbatim as the fixture's `create` block. Returns
     * the scenario id so the caller can request its recipe.
     */
    async seedScenarioRecipeVersion(params: {
        organizationId: string;
        applicationId: string;
        snapshotId: string;
        scenarioName: string;
        description?: string;
        create: Record<string, unknown>;
    }): Promise<string> {
        const { organizationId, applicationId, snapshotId, scenarioName, create } = params;

        const scenario = await this.db.scenario.create({
            data: { name: scenarioName, applicationId, organizationId },
        });

        // One schema snapshot per (application, snapshot); reused across scenarios.
        const schemaSnapshot = await this.db.scenarioSchemaSnapshot.upsert({
            where: { applicationId_snapshotId: { applicationId, snapshotId } },
            create: {
                applicationId,
                snapshotId,
                structureJson: { models: {} },
                fingerprint: `schema-${uniqueSuffix()}`,
            },
            update: {},
        });

        await this.db.scenarioRecipeVersion.create({
            data: {
                scenarioId: scenario.id,
                snapshotId,
                schemaSnapshotId: schemaSnapshot.id,
                applicationId,
                organizationId,
                scenarioNameSnapshot: scenarioName,
                description: params.description ?? null,
                fingerprint: `recipe-${uniqueSuffix()}`,
                validationStatus: "validated",
                validationMethod: "checkScenario",
                validationPhase: "ok",
                fixtureJson: {
                    name: scenarioName,
                    description: params.description ?? "",
                    create,
                    validation: { status: "validated", method: "checkScenario", phase: "ok" },
                },
            },
        });

        return scenario.id;
    }

    /**
     * Materialize a complete generation graph the loader reads from: a snapshot
     * (optionally with SHAs), a test case + plan, and the generation with its
     * executed steps + (optional) conversation stored in the harness storage.
     */
    async seedGeneration(params: SeedGenerationParams): Promise<SeededGeneration> {
        const { organizationId, applicationId } = params;
        const suffix = uniqueSuffix();

        const branch = await this.db.branch.create({
            data: { name: `branch-${suffix}`, organizationId, applicationId },
        });
        const folder = await this.db.folder.create({
            data: { name: `folder-${suffix}`, applicationId, organizationId },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: {
                branchId: branch.id,
                source: "MANUAL",
                baseSha: params.baseSha ?? null,
                headSha: params.headSha ?? null,
            },
        });

        const testCase = await this.db.testCase.create({
            data: {
                name: params.testName ?? `Test ${suffix}`,
                slug: `test-${suffix}`,
                applicationId,
                folderId: folder.id,
                organizationId,
            },
        });
        const plan = await this.createPlan(
            testCase.id,
            params.testPlanPrompt ?? "Original plan prompt",
            organizationId,
        );

        const scenarioInstanceId =
            params.scenario != null
                ? await this.createScenarioInstance(organizationId, applicationId, params.scenario)
                : undefined;

        const generation = await this.createGeneration({
            organizationId,
            snapshotId: snapshot.id,
            planId: plan.id,
            status: params.status ?? "failed",
            reasoning: params.reasoning,
            videoUrl: params.videoUrl,
            finalScreenshot: params.finalScreenshot,
            conversation: params.conversation,
            steps: params.steps ?? [],
            legacyStepInputs: params.legacyStepInputs ?? [],
            scenarioInstanceId,
        });

        return { generationId: generation.id, snapshotId: snapshot.id, testCaseId: testCase.id, planId: plan.id };
    }

    private async createGeneration(args: {
        organizationId: string;
        snapshotId: string;
        planId: string;
        status: GenerationStatus;
        reasoning?: string;
        videoUrl?: string;
        finalScreenshot?: string;
        conversation?: ModelMessage[];
        steps: SeedGenerationStep[];
        legacyStepInputs?: SeedGenerationStep[];
        scenarioInstanceId?: string;
    }): Promise<{ id: string }> {
        const conversationUrl = this.storeConversation(args.conversation);

        // Legacy replay-list steps (StepInput/StepOutput) are linked via stepsId,
        // mirroring how pre-StepAttempt generations were persisted.
        const stepsId = await this.createGenerationSteps(args.planId, args.organizationId, args.legacyStepInputs ?? []);

        const generation = await this.db.testGeneration.create({
            data: {
                testPlanId: args.planId,
                snapshotId: args.snapshotId,
                organizationId: args.organizationId,
                status: args.status,
                reasoning: args.reasoning ?? null,
                videoUrl: args.videoUrl ?? null,
                finalScreenshot: args.finalScreenshot ?? null,
                conversationUrl: conversationUrl ?? null,
                stepsId: stepsId ?? null,
                scenarioInstanceId: args.scenarioInstanceId ?? null,
            },
            select: { id: true },
        });

        await this.createStepAttempts(generation.id, args.organizationId, args.steps);

        return generation;
    }

    private storeConversation(conversation: ModelMessage[] | undefined): string | undefined {
        if (conversation == null) return undefined;
        const key = `generation/${uniqueSuffix()}/conversation.json`;
        this.storage.put(key, Buffer.from(JSON.stringify(conversation), "utf-8"));
        return key;
    }

    /**
     * Legacy generation steps live on a StepInputList: each StepInput carries the
     * interaction/params + screenshots, and its single StepOutput carries the
     * command output. This is the pre-StepAttempt shape the loader falls back to.
     */
    private async createGenerationSteps(
        planId: string,
        organizationId: string,
        steps: SeedGenerationStep[],
    ): Promise<string | undefined> {
        if (steps.length === 0) return undefined;

        const inputList = await this.db.stepInputList.create({ data: { planId, organizationId } });
        const outputList = await this.db.stepOutputList.create({ data: { organizationId } });

        for (const step of steps) {
            const stepInput = await this.db.stepInput.create({
                data: {
                    listId: inputList.id,
                    order: step.order,
                    interaction: step.interaction,
                    params: step.params ?? {},
                    screenshotBefore: step.screenshotBefore ?? null,
                    screenshotAfter: step.screenshotAfter ?? null,
                    organizationId,
                },
            });
            await this.db.stepOutput.create({
                data: {
                    listId: outputList.id,
                    order: step.order,
                    output: step.output ?? {},
                    stepInputId: stepInput.id,
                    organizationId,
                },
            });
        }

        return inputList.id;
    }

    /**
     * Generation steps live on the `StepAttempt` timeline the loader reads back:
     * every attempt in order, a success carrying `output` and a failure carrying
     * `error` + `errorName`. Mirrors how the generation persister records attempts.
     */
    private async createStepAttempts(
        generationId: string,
        organizationId: string,
        steps: SeedGenerationStep[],
    ): Promise<void> {
        for (const step of steps) {
            await this.db.stepAttempt.create({
                data: {
                    generationId,
                    organizationId,
                    order: step.order,
                    interaction: step.interaction,
                    params: step.params ?? undefined,
                    status: step.status ?? "success",
                    output: step.output ?? undefined,
                    error: step.error ?? null,
                    errorName: step.errorName ?? null,
                    screenshotBefore: step.screenshotBefore ?? null,
                    screenshotAfter: step.screenshotAfter ?? null,
                },
            });
        }
    }

    private async createPlan(testCaseId: string, prompt: string, organizationId: string) {
        return this.db.testPlan.create({ data: { testCaseId, prompt, organizationId } });
    }
}

interface SeedResult {
    organizationId: string;
    applicationId: string;
}

type SuiteContext = { harness: DiffJobContextHarness; seedResult: SeedResult };

interface SuiteParams {
    name: string;
    cases: (test: TestAPI<SuiteContext>) => void;
}

export function diffJobContextSuite({ name, cases }: SuiteParams) {
    integrationTestSuite<DiffJobContextHarness, SeedResult>({
        name,
        createHarness: () => DiffJobContextHarness.create(),
        seed: async (harness) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            return { organizationId, applicationId };
        },
        cases,
    });
}
