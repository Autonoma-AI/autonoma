import { ApplicationArchitecture, type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect } from "vitest";
import { finalizeAnalysis } from "../../src/activities/analysis/finalize-analysis";

declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const POSTGRES_IMAGE = "postgres:17-alpine";
let seq = 0;
const next = () => seq++;

interface SeededRun {
    snapshotId: string;
    organizationId: string;
    branchId: string;
}

class FinalizeHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<FinalizeHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        globalThis.prisma = db;
        return new FinalizeHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pg.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    /** Seed a promotable run: a processing snapshot that is its branch's pending snapshot, plus its running job. */
    async seedRun(): Promise<SeededRun> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                organizationId: org.id,
                architecture: ApplicationArchitecture.WEB,
            },
        });
        const branch = await this.db.branch.create({
            data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "GITHUB_PUSH" },
        });
        // activate() requires the snapshot to be its branch's pending snapshot.
        await this.db.branch.update({ where: { id: branch.id }, data: { pendingSnapshotId: snapshot.id } });
        await this.db.analysisJob.create({
            data: { snapshotId: snapshot.id, organizationId: org.id, status: "running", startedAt: new Date() },
        });
        return { snapshotId: snapshot.id, organizationId: org.id, branchId: branch.id };
    }
}

integrationTestSuite({
    name: "finalizeAnalysis (promotion + job lifecycle)",
    createHarness: () => FinalizeHarness.create(),
    cases: (test) => {
        test("promotes the snapshot and completes the job on the happy path", async ({ harness }) => {
            const run = await harness.seedRun();

            const output = await finalizeAnalysis({ snapshotId: run.snapshotId });

            expect(output.promoted).toBe(true);
            const job = await harness.db.analysisJob.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(job?.status).toBe("completed");
            const snapshot = await harness.db.branchSnapshot.findUnique({ where: { id: run.snapshotId } });
            expect(snapshot?.status).toBe("active");
        });

        test("marks the job failed and does not promote on the failure path", async ({ harness }) => {
            const run = await harness.seedRun();

            const output = await finalizeAnalysis({ snapshotId: run.snapshotId, failureReason: "boom" });

            expect(output.promoted).toBe(false);
            const job = await harness.db.analysisJob.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(job?.status).toBe("failed");
            expect(job?.failureReason).toBe("boom");
            const snapshot = await harness.db.branchSnapshot.findUnique({ where: { id: run.snapshotId } });
            expect(snapshot?.status).not.toBe("active");
        });
    },
});
