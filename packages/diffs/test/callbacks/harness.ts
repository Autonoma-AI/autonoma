import { type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { AddSkill, AddTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestAPI } from "vitest";

const POSTGRES_IMAGE = "postgres:17-alpine";

export class DiffsCallbackHarness implements IntegrationHarness {
    public readonly db: PrismaClient;

    private pgContainer: StartedPostgreSqlContainer;

    constructor(db: PrismaClient, pgContainer: StartedPostgreSqlContainer) {
        this.db = db;
        this.pgContainer = pgContainer;
    }

    static async create(): Promise<DiffsCallbackHarness> {
        const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new DiffsCallbackHarness(db, pgContainer);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pgContainer.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    async createOrg(): Promise<string> {
        const date = Date.now();
        const org = await this.db.organization.create({
            data: { name: `Test Org ${date}`, slug: `test-org-${date}` },
        });
        return org.id;
    }

    async createApp(organizationId: string): Promise<string> {
        const date = Date.now();
        const app = await this.db.application.create({
            data: {
                name: `App ${date}`,
                slug: `app-${date}`,
                organizationId,
                architecture: "WEB",
            },
        });
        return app.id;
    }

    async createBranch(organizationId: string, applicationId: string): Promise<string> {
        const date = Date.now();
        const branch = await this.db.branch.create({
            data: {
                name: `branch-${date}`,
                organizationId,
                applicationId,
            },
        });
        return branch.id;
    }

    /**
     * Creates a branch with an active snapshot that has a test case assigned.
     * Returns the branchId and testCaseId for use in tests.
     */
    async setupBranchWithTest(
        organizationId: string,
        applicationId: string,
        testSlug: string,
        testName: string,
    ): Promise<{ branchId: string; testCaseId: string }> {
        const branchId = await this.createBranch(organizationId, applicationId);

        const updater = await TestSuiteUpdater.startUpdate({ db: this.db, branchId });
        await updater.apply(new AddTest({ name: testName, description: `Test: ${testName}`, plan: "initial plan" }));

        // Mark all pending generations as complete so we can finalize
        await this.db.testGeneration.updateMany({ where: { status: "pending" }, data: { status: "success" } });
        await updater.finalize();

        const testCase = await this.db.testCase.findFirstOrThrow({ where: { slug: testSlug, applicationId } });
        return { branchId, testCaseId: testCase.id };
    }

    /**
     * Creates a runnable test case with an assignment that has stepsId set.
     * This is required for triggerTestsAndWait to find a runnable assignment.
     */
    async setupRunnableTest(
        organizationId: string,
        applicationId: string,
        testSlug: string,
        testName: string,
    ): Promise<{ branchId: string; testCaseId: string; assignmentId: string }> {
        const { branchId, testCaseId } = await this.setupBranchWithTest(
            organizationId,
            applicationId,
            testSlug,
            testName,
        );

        // Create a StepInputList and link it to the assignment so findAssignmentWithSteps finds it
        const plan = await this.db.testPlan.findFirstOrThrow({ where: { testCaseId } });
        const stepInputList = await this.db.stepInputList.create({
            data: {
                planId: plan.id,
                organizationId,
                list: {
                    create: {
                        order: 0,
                        interaction: "click",
                        params: { target: "button" },
                        organizationId,
                    },
                },
            },
        });

        const assignment = await this.db.testCaseAssignment.findFirstOrThrow({
            where: { testCaseId },
            orderBy: { createdAt: "desc" },
        });

        await this.db.testCaseAssignment.update({
            where: { id: assignment.id },
            data: { stepsId: stepInputList.id },
        });

        return { branchId, testCaseId, assignmentId: assignment.id };
    }

    /**
     * Creates a branch with an active snapshot that has a skill assigned.
     * Returns the branchId and skillId for use in tests.
     */
    async setupBranchWithSkill(
        organizationId: string,
        applicationId: string,
        skillSlug: string,
        skillName: string,
        skillDescription: string,
    ): Promise<{ branchId: string; skillId: string }> {
        const branchId = await this.createBranch(organizationId, applicationId);

        const updater = await TestSuiteUpdater.startUpdate({ db: this.db, branchId });
        await updater.apply(new AddSkill({ name: skillName, description: skillDescription, plan: "initial content" }));
        await updater.finalize();

        const skill = await this.db.skill.findFirstOrThrow({ where: { slug: skillSlug, applicationId } });
        return { branchId, skillId: skill.id };
    }
}

interface SeedResult {
    organizationId: string;
    applicationId: string;
}

type DiffsCallbackSuiteContext = { harness: DiffsCallbackHarness; seedResult: SeedResult };

interface DiffsCallbackSuiteParams {
    name: string;
    cases: (test: TestAPI<DiffsCallbackSuiteContext>) => void;
}

export function diffsCallbackSuite({ name, cases }: DiffsCallbackSuiteParams) {
    integrationTestSuite<DiffsCallbackHarness, SeedResult>({
        name,
        createHarness: () => DiffsCallbackHarness.create(),
        seed: async (harness) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            return { organizationId, applicationId };
        },
        cases,
    });
}
