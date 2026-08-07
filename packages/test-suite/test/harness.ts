import { type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import type { TestAPI } from "vitest";
import { TestSuiteStore } from "../src/test-suite-store";

export class TestSuiteHarness implements IntegrationHarness {
    public readonly db: PrismaClient;
    public readonly store: TestSuiteStore;

    private counter = 0;

    constructor(db: PrismaClient) {
        this.db = db;
        this.store = new TestSuiteStore(db);
    }

    static async create(): Promise<TestSuiteHarness> {
        return new TestSuiteHarness(createClient(await createTestDatabase()));
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    next(): number {
        this.counter += 1;
        return this.counter;
    }

    async createOrg(): Promise<string> {
        const n = this.next();
        const org = await this.db.organization.create({
            data: { name: `Test Org ${n}`, slug: `test-org-${n}-${Date.now()}` },
        });
        return org.id;
    }

    async createApp(organizationId: string): Promise<string> {
        const n = this.next();
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}-${Date.now()}`,
                organizationId,
                architecture: "WEB",
            },
        });
        return app.id;
    }

    async createFolder(organizationId: string, applicationId: string, name = "default"): Promise<string> {
        const folder = await this.db.folder.create({ data: { name, applicationId, organizationId } });
        return folder.id;
    }

    async createBranch(
        organizationId: string,
        applicationId: string,
        options?: { prNumber?: number; asMain?: boolean },
    ): Promise<string> {
        const n = this.next();
        const branch = await this.db.branch.create({
            data: {
                name: `branch-${n}`,
                organizationId,
                applicationId,
                prInfo:
                    options?.prNumber != null ? { create: { applicationId, prNumber: options.prNumber } } : undefined,
            },
        });
        if (options?.asMain) {
            await this.db.application.update({ where: { id: applicationId }, data: { mainBranchId: branch.id } });
        }
        return branch.id;
    }

    /**
     * A fresh org/app/branch/folder for one test. The suite-level seed runs once per container, so
     * any test that mutates branch or application pointers must isolate itself with one of these.
     */
    async seedContext(): Promise<SeedResult> {
        const organizationId = await this.createOrg();
        const applicationId = await this.createApp(organizationId);
        const branchId = await this.createBranch(organizationId, applicationId);
        const folderId = await this.createFolder(organizationId, applicationId);
        return { organizationId, applicationId, branchId, folderId };
    }

    /** A test case with one plan, unassigned to any snapshot. */
    async createTestWithPlan(
        organizationId: string,
        applicationId: string,
        folderId: string,
        options?: { slug?: string; prompt?: string; scenarioId?: string },
    ): Promise<{ testCaseId: string; planId: string }> {
        const n = this.next();
        const testCase = await this.db.testCase.create({
            data: {
                name: `Test ${n}`,
                slug: options?.slug ?? `test-${n}`,
                organizationId,
                applicationId,
                folderId,
            },
        });
        const plan = await this.db.testPlan.create({
            data: {
                testCaseId: testCase.id,
                prompt: options?.prompt ?? `plan for test ${n}`,
                organizationId,
                scenarioId: options?.scenarioId,
            },
        });
        return { testCaseId: testCase.id, planId: plan.id };
    }

    /** An active snapshot on the branch holding the given assignments, wired as the branch's active pointer. */
    async createActiveSnapshot(
        branchId: string,
        options?: { headSha?: string; assignments?: Array<{ testCaseId: string; planId?: string }> },
    ): Promise<string> {
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId, source: "MANUAL", status: "active", headSha: options?.headSha },
            select: { id: true },
        });
        for (const assignment of options?.assignments ?? []) {
            await this.db.testCaseAssignment.create({
                data: { snapshotId: snapshot.id, testCaseId: assignment.testCaseId, planId: assignment.planId },
            });
        }
        await this.db.branch.update({ where: { id: branchId }, data: { activeSnapshotId: snapshot.id } });
        return snapshot.id;
    }
}

export interface SeedResult {
    organizationId: string;
    applicationId: string;
    branchId: string;
    folderId: string;
}

type TestSuiteSuiteContext = { harness: TestSuiteHarness; seedResult: SeedResult };

interface TestSuiteSuiteParams {
    name: string;
    cases: (test: TestAPI<TestSuiteSuiteContext>) => void;
}

export function testSuiteSuite({ name, cases }: TestSuiteSuiteParams) {
    integrationTestSuite<TestSuiteHarness, SeedResult>({
        name,
        createHarness: () => TestSuiteHarness.create(),
        seed: (harness) => harness.seedContext(),
        cases,
    });
}
