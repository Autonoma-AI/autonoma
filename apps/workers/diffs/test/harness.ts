import {
    type AffectedReason,
    type GenerationStatus,
    type Prisma,
    type PrismaClient,
    type RunReviewVerdict,
    type RunStatus,
    type ScenarioInstanceStatus,
    applyMigrations,
    createClient,
} from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import type { StorageProvider } from "@autonoma/storage";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { ModelMessage } from "ai";
import type { TestAPI } from "vitest";

const POSTGRES_IMAGE = "postgres:17-alpine";

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

/** One executed step to materialize as a StepInput + StepOutput pair on a run. */
export interface SeedStep {
    order: number;
    interaction: string;
    params: object;
    output: object;
    screenshotBefore?: string;
    screenshotAfter?: string;
}

export interface SeedFailedRunParams {
    organizationId: string;
    applicationId: string;
    /** When omitted, the snapshot is created without SHAs (exercises the SHA-missing path). */
    baseSha?: string;
    headSha?: string;
    /** When provided, a DiffsJob is created carrying this analysis reasoning. */
    analysisReasoning?: string;
    /** When provided, an AffectedTest row links this run with the given reason + reasoning. */
    affected?: { reason: AffectedReason; reasoning: string };
    testName?: string;
    testPlanPrompt?: string;
    steps?: SeedStep[];
    /** When provided, a Scenario + ScenarioInstance is created and the run is linked to it. */
    scenario?: SeedScenario;
}

export interface SeededRun {
    runId: string;
    snapshotId: string;
    testCaseId: string;
    assignmentId: string;
    planId: string;
    scenarioInstanceId?: string;
}

/** One flagged, replayed run to materialize inside a shared snapshot. */
export interface SeedSnapshotRun {
    /** Test case name; the slug is derived and returned keyed by this name. */
    testName: string;
    affectedReason: AffectedReason;
    affectedReasoning: string;
    /** Run terminal status. Defaults to `"failed"`. */
    runStatus?: RunStatus;
    planPrompt?: string;
    /**
     * A completed `RunReview` for this run. Omit to leave the run without a
     * completed review (so resolution sees no actionable verdict for it).
     * Provide `issue` to also link a bug Issue carrying title/description.
     */
    review?: {
        status?: "pending" | "completed" | "failed";
        verdict?: RunReviewVerdict;
        reasoning?: string;
        issue?: { title: string; description: string };
    };
    /** Attach a scenario instance whose generated-data graph the loader materializes. */
    scenario?: { name: string; status?: ScenarioInstanceStatus; generatedData?: unknown };
}

export interface SeedResolutionSnapshotParams {
    organizationId: string;
    applicationId: string;
    baseSha?: string;
    headSha?: string;
    /** When provided (or any run is flagged), a DiffsJob is created carrying this reasoning. */
    analysisReasoning?: string;
    runs: SeedSnapshotRun[];
}

export interface SeededResolutionSnapshot {
    snapshotId: string;
    /** Map from a run's test name to its run id, for assertions. */
    runIdByTestName: Record<string, string>;
}

/** One refinement iteration to materialize in a lineage graph. */
export interface SeedIteration {
    /** 1-based iteration number; iteration 1 is the seed iteration. */
    number: number;
    /** The plan prompt this iteration's run executed. */
    planPrompt: string;
    /**
     * The healing agent's reasoning that produced *this* iteration's plan. Maps
     * to an `update_plan` action attached to the previous iteration. Omit for the
     * seed iteration (1), whose plan no healing agent authored.
     */
    healingReasoning?: string;
    /**
     * A completed review verdict for this iteration's run. Omit to leave the run
     * without a completed review (so it contributes no prior verdict).
     */
    verdict?: { verdict: RunReviewVerdict; reasoning: string };
    /** Marks this iteration's run as the subject under review. Exactly one required. */
    subject?: boolean;
}

export interface SeedRefinementLineageParams {
    organizationId: string;
    applicationId: string;
    baseSha?: string;
    headSha?: string;
    testName?: string;
    iterations: SeedIteration[];
    /** Steps attached to the subject run. */
    steps?: SeedStep[];
}

export interface SeededLineage {
    subjectRunId: string;
    snapshotId: string;
    testCaseId: string;
    loopId: string;
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
    /** When provided, a DiffsJob is created carrying this analysis reasoning. */
    analysisReasoning?: string;
    /** When provided, an AffectedTest row links this generation with the given reason + reasoning. */
    affected?: { reason: AffectedReason; reasoning: string };
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

/** One refinement iteration in a generation-subject lineage graph. */
export interface SeedGenerationIteration {
    number: number;
    planPrompt: string;
    healingReasoning?: string;
    /** A completed RunReview verdict for this iteration's run. Omit to contribute no prior verdict. */
    verdict?: { verdict: RunReviewVerdict; reasoning: string };
    /** Marks this iteration as the subject - it materializes a generation, not a run. Exactly one required. */
    subject?: boolean;
}

export interface SeedGenerationLineageParams {
    organizationId: string;
    applicationId: string;
    baseSha?: string;
    headSha?: string;
    testName?: string;
    iterations: SeedGenerationIteration[];
    /** Steps attached to the subject generation. */
    steps?: SeedGenerationStep[];
    conversation?: ModelMessage[];
}

export interface SeededGenerationLineage {
    subjectGenerationId: string;
    snapshotId: string;
    testCaseId: string;
    loopId: string;
}

/**
 * One failing test in a healing iteration. Its `iterations` describe the full
 * refinement chain oldest-first; the entry flagged `subject: true` is the
 * iteration whose generation/run is the *current* failure healing must address
 * (earlier iterations contribute the lineage: their plan rewrites + verdicts).
 * `subjectSource` selects whether that failing subject is a generation or a run.
 */
export interface SeedHealingSubject {
    testName: string;
    /** When provided, an AffectedTest row links the failing subject with this reason + reasoning. */
    affected?: { reason: AffectedReason; reasoning: string };
    iterations: SeedIteration[];
    /** The failing subject is a generation when "generation", else a run. Defaults to "replay". */
    subjectSource?: "generation" | "replay";
    /** Attach a scenario instance to the failing subject whose generated-data graph the loader materializes. */
    scenario?: { name: string; status?: ScenarioInstanceStatus; generatedData?: unknown };
}

export interface SeedHealingIterationParams {
    organizationId: string;
    applicationId: string;
    baseSha?: string;
    headSha?: string;
    analysisReasoning?: string;
    subjects: SeedHealingSubject[];
}

/** A failing subject as the workflow would describe it to {@link DiffJobContextLoader.loadHealingContext}. */
export interface SeededHealingSubject {
    failureKey: string;
    source: "generation" | "replay";
    sourceId: string;
    planId: string;
    testCaseId: string;
    testName: string;
}

export interface SeededHealingIteration {
    snapshotId: string;
    loopId: string;
    subjects: SeededHealingSubject[];
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
     * Materialize a complete failed-run graph the loader reads from: a snapshot
     * (optionally with SHAs + a DiffsJob), a test case + plan + assignment, the
     * run with its executed steps, and an optional AffectedTest linking the run.
     */
    async seedFailedRun(params: SeedFailedRunParams): Promise<SeededRun> {
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

        // AffectedTest.snapshotId is an FK to DiffsJob.snapshotId, so a DiffsJob
        // must exist whenever the run is flagged - even if analysis recorded no
        // reasoning. Mirror that: create the job if either piece is present.
        if (params.analysisReasoning != null || params.affected != null) {
            await this.db.diffsJob.create({
                data: {
                    snapshotId: snapshot.id,
                    organizationId,
                    status: "completed",
                    analysisReasoning: params.analysisReasoning ?? null,
                },
            });
        }

        const testCase = await this.db.testCase.create({
            data: {
                name: params.testName ?? `Test ${suffix}`,
                slug: `test-${suffix}`,
                applicationId,
                folderId: folder.id,
                organizationId,
            },
        });

        const plan = await this.db.testPlan.create({
            data: {
                testCaseId: testCase.id,
                prompt: params.testPlanPrompt ?? "Original plan prompt",
                organizationId,
            },
        });

        const assignment = await this.db.testCaseAssignment.create({
            data: { snapshotId: snapshot.id, testCaseId: testCase.id, planId: plan.id },
        });

        const scenarioInstanceId =
            params.scenario != null
                ? await this.createScenarioInstance(organizationId, applicationId, params.scenario)
                : undefined;

        const run = await this.db.run.create({
            data: {
                assignmentId: assignment.id,
                planId: plan.id,
                organizationId,
                status: "failed",
                scenarioInstanceId,
            },
        });

        await this.attachSteps(run.id, plan.id, organizationId, params.steps ?? []);

        if (params.affected != null) {
            await this.db.affectedTest.create({
                data: {
                    snapshotId: snapshot.id,
                    testCaseId: testCase.id,
                    affectedReason: params.affected.reason,
                    reasoning: params.affected.reasoning,
                    runId: run.id,
                    organizationId,
                },
            });
        }

        return {
            runId: run.id,
            snapshotId: snapshot.id,
            testCaseId: testCase.id,
            assignmentId: assignment.id,
            planId: plan.id,
            scenarioInstanceId,
        };
    }

    /**
     * Materialize a single snapshot carrying multiple flagged, replayed runs -
     * the graph `DiffJobContextLoader.loadSnapshot` reads. Each run gets its own
     * test case + plan + assignment + run + AffectedTest, plus an optional
     * completed review (with an optional linked Issue) and scenario instance.
     * Unlike {@link seedFailedRun}, every run shares one snapshot, which is the
     * whole point of snapshot-scope gathering.
     */
    async seedResolutionSnapshot(params: SeedResolutionSnapshotParams): Promise<SeededResolutionSnapshot> {
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

        // AffectedTest.snapshotId FKs to DiffsJob.snapshotId, so a flagged run
        // requires a DiffsJob - create one whenever there is anything to flag.
        if (params.analysisReasoning != null || params.runs.length > 0) {
            await this.db.diffsJob.create({
                data: {
                    snapshotId: snapshot.id,
                    organizationId,
                    status: "completed",
                    analysisReasoning: params.analysisReasoning ?? null,
                },
            });
        }

        const runIdByTestName: Record<string, string> = {};

        for (const [index, spec] of params.runs.entries()) {
            const runId = await this.seedSnapshotRun(
                snapshot.id,
                folder.id,
                organizationId,
                applicationId,
                index,
                spec,
            );
            runIdByTestName[spec.testName] = runId;
        }

        return { snapshotId: snapshot.id, runIdByTestName };
    }

    private async seedSnapshotRun(
        snapshotId: string,
        folderId: string,
        organizationId: string,
        applicationId: string,
        index: number,
        spec: SeedSnapshotRun,
    ): Promise<string> {
        const suffix = uniqueSuffix();
        const testCase = await this.db.testCase.create({
            data: {
                name: spec.testName,
                slug: `test-${index}-${suffix}`,
                applicationId,
                folderId,
                organizationId,
            },
        });
        const plan = await this.db.testPlan.create({
            data: { testCaseId: testCase.id, prompt: spec.planPrompt ?? "Original plan prompt", organizationId },
        });

        const assignment = await this.db.testCaseAssignment.create({
            data: { snapshotId, testCaseId: testCase.id, planId: plan.id },
        });

        const scenarioInstanceId =
            spec.scenario != null
                ? await this.createScenarioInstance(organizationId, applicationId, spec.scenario)
                : undefined;

        const run = await this.db.run.create({
            data: {
                assignmentId: assignment.id,
                planId: plan.id,
                organizationId,
                status: spec.runStatus ?? "failed",
                scenarioInstanceId,
            },
        });

        if (spec.review != null) {
            await this.createRunReview(run.id, organizationId, spec.review);
        }

        await this.db.affectedTest.create({
            data: {
                snapshotId,
                testCaseId: testCase.id,
                affectedReason: spec.affectedReason,
                reasoning: spec.affectedReasoning,
                runId: run.id,
                organizationId,
            },
        });

        return run.id;
    }

    private async createRunReview(
        runId: string,
        organizationId: string,
        review: NonNullable<SeedSnapshotRun["review"]>,
    ): Promise<void> {
        const created = await this.db.runReview.create({
            data: {
                runId,
                organizationId,
                status: review.status ?? "completed",
                verdict: review.verdict ?? null,
                reasoning: review.reasoning ?? null,
            },
        });

        if (review.issue != null) {
            await this.db.issue.create({
                data: {
                    runReviewId: created.id,
                    organizationId,
                    severity: "high",
                    title: review.issue.title,
                    description: review.issue.description,
                },
            });
        }
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
     * Re-point an assignment's plan to a freshly created plan (simulating a
     * healing `updatePlan`). The run keeps its original `planId`, which is what
     * the loader must read - this is the point-in-time guarantee.
     */
    async repointAssignmentPlan(
        assignmentId: string,
        testCaseId: string,
        organizationId: string,
        newPrompt: string,
    ): Promise<string> {
        const newPlan = await this.db.testPlan.create({
            data: { testCaseId, prompt: newPrompt, organizationId },
        });
        await this.db.testCaseAssignment.update({ where: { id: assignmentId }, data: { planId: newPlan.id } });
        return newPlan.id;
    }

    /**
     * Materialize a full refinement-loop lineage graph for a single test: a
     * snapshot, a loop, and one iteration per entry in `params.iterations`, each
     * with its own plan, run, optional completed review, and (for non-seed
     * iterations) an `update_plan` action carrying the healing reasoning. Returns
     * the subject run id (the iteration flagged `subject: true`).
     */
    async seedRefinementLineage(params: SeedRefinementLineageParams): Promise<SeededLineage> {
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
        const loop = await this.db.refinementLoop.create({
            data: { snapshotId: snapshot.id, triggeredBy: "diffs", organizationId },
        });

        // One assignment per snapshot+test; its plan is re-pointed each iteration,
        // mirroring how healing updates the assignment while each run keeps its own
        // executed plan via run.planId.
        const firstPlan = await this.createPlan(
            testCase.id,
            params.iterations[0]?.planPrompt ?? "seed",
            organizationId,
        );
        const assignment = await this.db.testCaseAssignment.create({
            data: { snapshotId: snapshot.id, testCaseId: testCase.id, planId: firstPlan.id },
        });

        const created: Array<{ id: string; planId: string }> = [];
        let subjectRunId: string | undefined;

        for (const [index, spec] of params.iterations.entries()) {
            const plan = index === 0 ? firstPlan : await this.createPlan(testCase.id, spec.planPrompt, organizationId);

            const iteration = await this.db.refinementIteration.create({
                data: { loopId: loop.id, number: spec.number, status: "completed" },
            });
            await this.db.refinementIterationInput.create({
                data: { iterationId: iteration.id, planId: plan.id },
            });

            // The action that produced this plan is attached to the *previous*
            // iteration (the one whose healing run authored the rewrite).
            const previous = created[index - 1];
            if (spec.healingReasoning != null && previous != null) {
                await this.db.refinementAction.create({
                    data: {
                        iterationId: previous.id,
                        planId: plan.id,
                        testCaseId: testCase.id,
                        kind: "update_plan",
                        payload: {},
                        reasoning: spec.healingReasoning,
                    },
                });
            }

            await this.db.testCaseAssignment.update({ where: { id: assignment.id }, data: { planId: plan.id } });
            const run = await this.db.run.create({
                data: { assignmentId: assignment.id, planId: plan.id, organizationId, status: "failed" },
            });

            if (spec.verdict != null) {
                await this.db.runReview.create({
                    data: {
                        runId: run.id,
                        organizationId,
                        status: "completed",
                        verdict: spec.verdict.verdict,
                        reasoning: spec.verdict.reasoning,
                    },
                });
            }

            if (spec.subject === true) {
                subjectRunId = run.id;
                await this.attachSteps(run.id, plan.id, organizationId, params.steps ?? []);
            }

            created.push({ id: iteration.id, planId: plan.id });
        }

        if (subjectRunId == null) {
            throw new Error("seedRefinementLineage requires exactly one iteration flagged subject: true");
        }

        return { subjectRunId, snapshotId: snapshot.id, testCaseId: testCase.id, loopId: loop.id };
    }

    /**
     * Materialize a complete generation graph the loader reads from: a snapshot
     * (optionally with SHAs + a DiffsJob), a test case + plan, the generation
     * with its executed steps + (optional) conversation stored in the harness
     * storage, and an optional AffectedTest linking the generation.
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

        if (params.analysisReasoning != null || params.affected != null) {
            await this.db.diffsJob.create({
                data: {
                    snapshotId: snapshot.id,
                    organizationId,
                    status: "completed",
                    analysisReasoning: params.analysisReasoning ?? null,
                },
            });
        }

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

        if (params.affected != null) {
            await this.db.affectedTest.create({
                data: {
                    snapshotId: snapshot.id,
                    testCaseId: testCase.id,
                    affectedReason: params.affected.reason,
                    reasoning: params.affected.reasoning,
                    generationId: generation.id,
                    organizationId,
                },
            });
        }

        return { generationId: generation.id, snapshotId: snapshot.id, testCaseId: testCase.id, planId: plan.id };
    }

    /**
     * Materialize a refinement-loop lineage graph whose subject is a *generation*
     * (not a run): earlier iterations execute runs with completed RunReviews, and
     * the subject iteration materializes a generation against its healed plan.
     * Mirrors {@link seedRefinementLineage} so the loader's lineage walk - which is
     * subject-agnostic - can be exercised from the generation entry point.
     */
    async seedGenerationRefinementLineage(params: SeedGenerationLineageParams): Promise<SeededGenerationLineage> {
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
        const loop = await this.db.refinementLoop.create({
            data: { snapshotId: snapshot.id, triggeredBy: "diffs", organizationId },
        });

        const firstPlan = await this.createPlan(
            testCase.id,
            params.iterations[0]?.planPrompt ?? "seed",
            organizationId,
        );
        const assignment = await this.db.testCaseAssignment.create({
            data: { snapshotId: snapshot.id, testCaseId: testCase.id, planId: firstPlan.id },
        });

        const created: Array<{ id: string }> = [];
        let subjectGenerationId: string | undefined;

        for (const [index, spec] of params.iterations.entries()) {
            const plan = index === 0 ? firstPlan : await this.createPlan(testCase.id, spec.planPrompt, organizationId);

            const iteration = await this.db.refinementIteration.create({
                data: { loopId: loop.id, number: spec.number, status: "completed" },
            });
            await this.db.refinementIterationInput.create({
                data: { iterationId: iteration.id, planId: plan.id },
            });

            const previous = created[index - 1];
            if (spec.healingReasoning != null && previous != null) {
                await this.db.refinementAction.create({
                    data: {
                        iterationId: previous.id,
                        planId: plan.id,
                        testCaseId: testCase.id,
                        kind: "update_plan",
                        payload: {},
                        reasoning: spec.healingReasoning,
                    },
                });
            }

            await this.db.testCaseAssignment.update({ where: { id: assignment.id }, data: { planId: plan.id } });

            if (spec.subject === true) {
                const generation = await this.createGeneration({
                    organizationId,
                    snapshotId: snapshot.id,
                    planId: plan.id,
                    status: "failed",
                    conversation: params.conversation,
                    steps: params.steps ?? [],
                });
                subjectGenerationId = generation.id;
            } else {
                const run = await this.db.run.create({
                    data: { assignmentId: assignment.id, planId: plan.id, organizationId, status: "failed" },
                });
                if (spec.verdict != null) {
                    await this.db.runReview.create({
                        data: {
                            runId: run.id,
                            organizationId,
                            status: "completed",
                            verdict: spec.verdict.verdict,
                            reasoning: spec.verdict.reasoning,
                        },
                    });
                }
            }

            created.push({ id: iteration.id });
        }

        if (subjectGenerationId == null) {
            throw new Error("seedGenerationRefinementLineage requires exactly one iteration flagged subject: true");
        }

        return { subjectGenerationId, snapshotId: snapshot.id, testCaseId: testCase.id, loopId: loop.id };
    }

    /**
     * Materialize a complete healing-iteration graph the loader's
     * `loadHealingContext` reads: one snapshot (optionally with SHAs + a DiffsJob
     * carrying analysis reasoning), a single refinement loop with shared
     * iterations, and one failing subject per entry in `params.subjects`. Each
     * subject gets its own test case, a per-iteration plan chain (linked to the
     * shared iterations via RefinementIterationInput, with `update_plan` actions
     * carrying healing reasoning and earlier runs carrying completed reviews),
     * an optional AffectedTest, and an optional scenario on the failing subject.
     * Returns the failing subjects shaped as the workflow would pass them in.
     */
    async seedHealingIteration(params: SeedHealingIterationParams): Promise<SeededHealingIteration> {
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

        // AffectedTest.snapshotId FKs to DiffsJob.snapshotId, and analysisReasoning
        // lives on the DiffsJob - create one whenever either is in play.
        const anyAffected = params.subjects.some((subject) => subject.affected != null);
        if (params.analysisReasoning != null || anyAffected) {
            await this.db.diffsJob.create({
                data: {
                    snapshotId: snapshot.id,
                    organizationId,
                    status: "completed",
                    analysisReasoning: params.analysisReasoning ?? null,
                },
            });
        }

        const loop = await this.db.refinementLoop.create({
            data: { snapshotId: snapshot.id, triggeredBy: "diffs", organizationId },
        });

        // Iterations are shared across every test in the loop (numbered per loop),
        // so create them once; each subject links its per-iteration plan to them.
        const maxNumber = Math.max(...params.subjects.flatMap((subject) => subject.iterations.map((it) => it.number)));
        const iterationByNumber = new Map<number, string>();
        for (const number of Array.from({ length: maxNumber }, (_unused, index) => index + 1)) {
            const iteration = await this.db.refinementIteration.create({
                data: { loopId: loop.id, number, status: "completed" },
            });
            iterationByNumber.set(number, iteration.id);
        }

        const subjects: SeededHealingSubject[] = [];
        for (const [index, spec] of params.subjects.entries()) {
            subjects.push(
                await this.seedHealingSubject({
                    snapshotId: snapshot.id,
                    folderId: folder.id,
                    organizationId,
                    applicationId,
                    iterationByNumber,
                    index,
                    spec,
                }),
            );
        }

        return { snapshotId: snapshot.id, loopId: loop.id, subjects };
    }

    private async seedHealingSubject(args: {
        snapshotId: string;
        folderId: string;
        organizationId: string;
        applicationId: string;
        iterationByNumber: Map<number, string>;
        index: number;
        spec: SeedHealingSubject;
    }): Promise<SeededHealingSubject> {
        const { snapshotId, folderId, organizationId, applicationId, iterationByNumber, index, spec } = args;
        const suffix = uniqueSuffix();

        const testCase = await this.db.testCase.create({
            data: {
                name: spec.testName,
                slug: `test-${index}-${suffix}`,
                applicationId,
                folderId,
                organizationId,
            },
        });

        const firstPlan = await this.createPlan(testCase.id, spec.iterations[0]?.planPrompt ?? "seed", organizationId);
        const assignment = await this.db.testCaseAssignment.create({
            data: { snapshotId, testCaseId: testCase.id, planId: firstPlan.id },
        });

        const scenarioInstanceId =
            spec.scenario != null
                ? await this.createScenarioInstance(organizationId, applicationId, spec.scenario)
                : undefined;

        let subjectInfo: { source: "generation" | "replay"; sourceId: string; planId: string } | undefined;

        for (const [iterIndex, it] of spec.iterations.entries()) {
            const plan =
                iterIndex === 0 ? firstPlan : await this.createPlan(testCase.id, it.planPrompt, organizationId);

            const iterationId = iterationByNumber.get(it.number);
            if (iterationId == null) throw new Error(`No shared iteration seeded for number ${it.number}`);
            await this.db.refinementIterationInput.create({ data: { iterationId, planId: plan.id } });

            // The rewrite that produced this plan is attached to the previous
            // iteration (the one whose healing run authored it).
            const previousIterationId = iterationByNumber.get(it.number - 1);
            if (it.healingReasoning != null && previousIterationId != null) {
                await this.db.refinementAction.create({
                    data: {
                        iterationId: previousIterationId,
                        planId: plan.id,
                        testCaseId: testCase.id,
                        kind: "update_plan",
                        payload: {},
                        reasoning: it.healingReasoning,
                    },
                });
            }

            await this.db.testCaseAssignment.update({ where: { id: assignment.id }, data: { planId: plan.id } });

            const isSubject = it.subject === true;
            if (isSubject && spec.subjectSource === "generation") {
                const generation = await this.createGeneration({
                    organizationId,
                    snapshotId,
                    planId: plan.id,
                    status: "failed",
                    steps: [],
                    scenarioInstanceId,
                });
                subjectInfo = { source: "generation", sourceId: generation.id, planId: plan.id };
            } else {
                const run = await this.db.run.create({
                    data: {
                        assignmentId: assignment.id,
                        planId: plan.id,
                        organizationId,
                        status: "failed",
                        scenarioInstanceId: isSubject ? scenarioInstanceId : undefined,
                    },
                });
                if (it.verdict != null) {
                    await this.db.runReview.create({
                        data: {
                            runId: run.id,
                            organizationId,
                            status: "completed",
                            verdict: it.verdict.verdict,
                            reasoning: it.verdict.reasoning,
                        },
                    });
                }
                if (isSubject) subjectInfo = { source: "replay", sourceId: run.id, planId: plan.id };
            }
        }

        if (subjectInfo == null) {
            throw new Error("seedHealingIteration requires exactly one iteration flagged subject: true per subject");
        }

        if (spec.affected != null) {
            await this.db.affectedTest.create({
                data: {
                    snapshotId,
                    testCaseId: testCase.id,
                    affectedReason: spec.affected.reason,
                    reasoning: spec.affected.reasoning,
                    runId: subjectInfo.source === "replay" ? subjectInfo.sourceId : null,
                    generationId: subjectInfo.source === "generation" ? subjectInfo.sourceId : null,
                    organizationId,
                },
            });
        }

        return {
            failureKey: subjectInfo.sourceId,
            source: subjectInfo.source,
            sourceId: subjectInfo.sourceId,
            planId: subjectInfo.planId,
            testCaseId: testCase.id,
            testName: spec.testName,
        };
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

    private async attachSteps(runId: string, planId: string, organizationId: string, steps: SeedStep[]): Promise<void> {
        if (steps.length === 0) return;

        const stepInputList = await this.db.stepInputList.create({ data: { planId, organizationId } });
        const stepOutputList = await this.db.stepOutputList.create({ data: { runId, organizationId } });

        for (const step of steps) {
            const stepInput = await this.db.stepInput.create({
                data: {
                    listId: stepInputList.id,
                    order: step.order,
                    interaction: step.interaction,
                    params: step.params,
                    organizationId,
                },
            });
            await this.db.stepOutput.create({
                data: {
                    listId: stepOutputList.id,
                    order: step.order,
                    output: step.output,
                    stepInputId: stepInput.id,
                    screenshotBefore: step.screenshotBefore ?? null,
                    screenshotAfter: step.screenshotAfter ?? null,
                    organizationId,
                },
            });
        }
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
