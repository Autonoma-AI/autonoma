import { type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestAPI } from "vitest";

const POSTGRES_IMAGE = "postgres:17-alpine";

export class CheckpointHarness implements IntegrationHarness {
    public readonly db: PrismaClient;

    private pgContainer: StartedPostgreSqlContainer;

    constructor(db: PrismaClient, pgContainer: StartedPostgreSqlContainer) {
        this.db = db;
        this.pgContainer = pgContainer;
    }

    static async create(): Promise<CheckpointHarness> {
        const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new CheckpointHarness(db, pgContainer);
    }

    async beforeAll() {
        // No-op - harness is ready after create()
    }

    async afterAll() {
        await this.pgContainer.stop();
    }

    async beforeEach() {
        // No-op
    }

    async afterEach() {
        // No-op
    }

    async createOrg(): Promise<string> {
        const org = await this.db.organization.create({
            data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
        });
        return org.id;
    }

    /** Creates an application with a branch + active snapshot, and returns their ids. */
    async createSnapshot(
        organizationId: string,
    ): Promise<{ applicationId: string; snapshotId: string; folderId: string }> {
        const application = await this.db.application.create({
            data: {
                name: `App ${crypto.randomUUID()}`,
                slug: `app-${crypto.randomUUID()}`,
                organizationId,
                architecture: "WEB",
            },
        });
        const branch = await this.db.branch.create({
            data: { name: `branch-${crypto.randomUUID()}`, organizationId, applicationId: application.id },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "MANUAL", status: "active", baseSha: "base", headSha: "head" },
        });
        const folder = await this.db.folder.create({
            data: { name: "Default", applicationId: application.id, organizationId },
        });
        return { applicationId: application.id, snapshotId: snapshot.id, folderId: folder.id };
    }

    async createAssignment(input: {
        organizationId: string;
        applicationId: string;
        folderId: string;
        snapshotId: string;
        name: string;
    }): Promise<{ id: string; testCaseId: string }> {
        const slug = `${input.name.toLowerCase().replaceAll(" ", "-")}-${crypto.randomUUID()}`;
        const testCase = await this.db.testCase.create({
            data: {
                name: input.name,
                slug,
                applicationId: input.applicationId,
                folderId: input.folderId,
                organizationId: input.organizationId,
            },
        });
        const assignment = await this.db.testCaseAssignment.create({
            data: { snapshotId: input.snapshotId, testCaseId: testCase.id },
        });
        return { id: assignment.id, testCaseId: testCase.id };
    }

    async createRun(input: {
        organizationId: string;
        assignmentId: string;
        status: "pending" | "running" | "success" | "failed";
        at: Date;
        failure?: { kind: string; message?: string };
    }) {
        return this.db.run.create({
            data: {
                assignmentId: input.assignmentId,
                status: input.status,
                startedAt: input.at,
                createdAt: input.at,
                failure: input.failure,
                organizationId: input.organizationId,
            },
        });
    }

    /** Files an open application bug attached to a run review on the given run. */
    async fileOpenBug(input: { organizationId: string; applicationId: string; runId: string }) {
        const review = await this.db.runReview.create({
            data: {
                runId: input.runId,
                status: "completed",
                verdict: "application_bug",
                reasoning: "Application bug.",
                organizationId: input.organizationId,
            },
        });
        const bug = await this.db.bug.create({
            data: {
                status: "open",
                title: "Checkout broken",
                description: "The checkout button does nothing.",
                severity: "high",
                application: { connect: { id: input.applicationId } },
                organization: { connect: { id: input.organizationId } },
            },
        });
        await this.db.issue.create({
            data: {
                runReviewId: review.id,
                bugId: bug.id,
                kind: "application_bug",
                severity: "high",
                title: "Checkout broken",
                description: "The checkout button does nothing.",
                organizationId: input.organizationId,
            },
        });
        return { bugId: bug.id };
    }
}

type CheckpointSuiteContext = { harness: CheckpointHarness; seedResult: undefined };

interface CheckpointSuiteParams {
    name: string;
    cases: (test: TestAPI<CheckpointSuiteContext>) => void;
}

export function checkpointSuite({ name, cases }: CheckpointSuiteParams) {
    integrationTestSuite<CheckpointHarness, undefined>({
        name,
        createHarness: () => CheckpointHarness.create(),
        seed: async () => undefined,
        cases,
    });
}
