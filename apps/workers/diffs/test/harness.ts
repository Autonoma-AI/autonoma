import {
    type AffectedReason,
    type PrismaClient,
    type ScenarioInstanceStatus,
    applyMigrations,
    createClient,
} from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestAPI } from "vitest";

const POSTGRES_IMAGE = "postgres:17-alpine";

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
    /**
     * When provided, a Scenario + ScenarioInstance is created and the run is
     * linked to it. `status` defaults to `UP_SUCCESS`; `generatedData` is the
     * resolved create graph persisted at UP (omit it to exercise the
     * absent-data path).
     */
    scenario?: { name: string; status?: ScenarioInstanceStatus; generatedData?: unknown };
}

export interface SeededRun {
    runId: string;
    snapshotId: string;
    testCaseId: string;
    assignmentId: string;
    planId: string;
    scenarioInstanceId?: string;
}

let testSeq = 0;
function uniqueSuffix(): string {
    testSeq += 1;
    return `${testSeq}-${Math.floor(performance.now())}`;
}

export class ReplayContextHarness implements IntegrationHarness {
    public readonly db: PrismaClient;

    private readonly pgContainer: StartedPostgreSqlContainer;

    constructor(db: PrismaClient, pgContainer: StartedPostgreSqlContainer) {
        this.db = db;
        this.pgContainer = pgContainer;
    }

    static async create(): Promise<ReplayContextHarness> {
        const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new ReplayContextHarness(db, pgContainer);
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
     * Create a Scenario + ScenarioInstance the way the scenario manager does at
     * UP success: the resolved create graph lands on `generatedData`. Returns
     * the instance id so the caller can link a run to it.
     */
    private async createScenarioInstance(
        organizationId: string,
        applicationId: string,
        scenario: { name: string; status?: ScenarioInstanceStatus; generatedData?: unknown },
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
        return instance.id;
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

type SuiteContext = { harness: ReplayContextHarness; seedResult: SeedResult };

interface SuiteParams {
    name: string;
    cases: (test: TestAPI<SuiteContext>) => void;
}

export function replayContextSuite({ name, cases }: SuiteParams) {
    integrationTestSuite<ReplayContextHarness, SeedResult>({
        name,
        createHarness: () => ReplayContextHarness.create(),
        seed: async (harness) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            return { organizationId, applicationId };
        },
        cases,
    });
}
