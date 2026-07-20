import { type PrismaClient, SnapshotStatus, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, stopContainer } from "@autonoma/integration-test";
import type { StorageProvider } from "@autonoma/storage";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const POSTGRES_IMAGE = "postgres:17-alpine";

/**
 * In-memory storage provider for tests. Records every upload so tests can assert
 * on the keys (and key reuse) without touching real object storage.
 */
export class FakeStorageProvider implements StorageProvider {
    public readonly uploads = new Map<string, Buffer>();

    async upload(key: string, data: Buffer): Promise<string> {
        this.uploads.set(key, data);
        return `s3://fake/${key}`;
    }

    async uploadStream(): Promise<string> {
        throw new Error("uploadStream not implemented in FakeStorageProvider");
    }

    async download(key: string): Promise<Buffer> {
        const data = this.uploads.get(key);
        if (data == null) throw new Error(`No upload for key ${key}`);
        return data;
    }

    async delete(key: string): Promise<void> {
        this.uploads.delete(key);
    }

    async getSignedUrl(key: string): Promise<string> {
        return `s3://fake/${key}`;
    }
}

/** Identifiers for a generation and the chain of records it hangs off. */
export interface SeededGeneration {
    organizationId: string;
    applicationId: string;
    testPlanId: string;
    testCaseId: string;
    snapshotId: string;
    generationId: string;
}

/** Postgres-backed harness for GenerationPersister integration tests. */
export class PersisterTestHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pgContainer: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<PersisterTestHarness> {
        const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new PersisterTestHarness(db, pgContainer);
    }

    async beforeAll() {
        // No-op - harness is ready after create()
    }

    async afterAll() {
        await stopContainer(this.pgContainer);
    }

    async beforeEach() {
        // No-op
    }

    async afterEach() {
        // No-op
    }

    /** Creates an org -> app -> branch -> snapshot -> testCase -> testPlan -> generation chain. */
    async seedGeneration(): Promise<SeededGeneration> {
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

        const organization = await this.db.organization.create({
            data: { name: `Org ${stamp}`, slug: `org-${stamp}` },
        });
        const application = await this.db.application.create({
            data: {
                name: `App ${stamp}`,
                slug: `app-${stamp}`,
                organizationId: organization.id,
                architecture: "WEB",
            },
        });
        const branch = await this.db.branch.create({
            data: { name: "main", applicationId: application.id, organizationId: organization.id },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "MANUAL", status: SnapshotStatus.processing },
        });
        const folder = await this.db.folder.create({
            data: { name: `Folder ${stamp}`, applicationId: application.id, organizationId: organization.id },
        });
        const testCase = await this.db.testCase.create({
            data: {
                name: `Test Case ${stamp}`,
                slug: `test-case-${stamp}`,
                applicationId: application.id,
                organizationId: organization.id,
                folderId: folder.id,
            },
        });
        const testPlan = await this.db.testPlan.create({
            data: { prompt: "test prompt", testCaseId: testCase.id, organizationId: organization.id },
        });
        const generation = await this.db.testGeneration.create({
            data: {
                testPlanId: testPlan.id,
                snapshotId: snapshot.id,
                organizationId: organization.id,
                status: "pending",
                conversation: [],
            },
        });

        return {
            organizationId: organization.id,
            applicationId: application.id,
            testPlanId: testPlan.id,
            testCaseId: testCase.id,
            snapshotId: snapshot.id,
            generationId: generation.id,
        };
    }
}
