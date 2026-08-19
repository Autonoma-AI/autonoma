import { createClient, type PrismaClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import type { PreviewNamespace, PreviewNamespaces } from "../src/preview-reaper";
import { PreviewReaper } from "../src/preview-reaper";

const NOW = new Date("2026-08-19T12:00:00Z");
const FRESH = new Date("2026-08-18T12:00:00Z");
const ANCIENT = new Date("2026-07-01T12:00:00Z");

/** A stand-in cluster. Real Postgres, faked Kubernetes - the rules under test are about rows. */
class FakeNamespaces implements PreviewNamespaces {
    readonly deleted: string[] = [];

    constructor(private namespaces: PreviewNamespace[]) {}

    async list(): Promise<PreviewNamespace[]> {
        return this.namespaces;
    }

    async delete(name: string): Promise<void> {
        this.deleted.push(name);
        this.namespaces = this.namespaces.filter((namespace) => namespace.name !== name);
    }
}

class ReaperHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<ReaperHarness> {
        return new ReaperHarness(createClient(await createTestDatabase()));
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {
        await this.db.$executeRawUnsafe('TRUNCATE TABLE "organization" CASCADE');
    }
    async afterEach() {}

    async seedEnvironment(namespace: string): Promise<string> {
        const org = await this.db.organization.create({
            data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
        });
        const environment = await this.db.previewkitEnvironment.create({
            data: {
                organizationId: org.id,
                namespace,
                repoFullName: "acme/web",
                prNumber: Math.floor(Math.random() * 100_000),
                headSha: "sha",
                headRef: "branch",
                status: "ready",
            },
        });
        return environment.id;
    }

    async statusOf(id: string) {
        return await this.db.previewkitEnvironment.findUniqueOrThrow({
            where: { id },
            select: { status: true, tornDownAt: true },
        });
    }
}

integrationTestSuite({
    name: "PreviewReaper",
    createHarness: () => ReaperHarness.create(),
    cases: (test) => {
        /**
         * The 814 rows this job exists for: the namespace went without anything
         * telling the row, so it has been claiming `ready` ever since.
         */
        test("marks a row whose namespace is already gone, and deletes nothing", async ({ harness }) => {
            const id = await harness.seedEnvironment("preview-acme-web-pr-1");
            const cluster = new FakeNamespaces([]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.markedGone).toBe(1);
            expect(cluster.deleted).toEqual([]);
            const after = await harness.statusOf(id);
            expect(after.status).toBe("torn_down");
            expect(after.tornDownAt).not.toBeNull();
        });

        test("reaps a namespace past the TTL and marks its row in the same pass", async ({ harness }) => {
            const id = await harness.seedEnvironment("preview-acme-web-pr-2");
            const cluster = new FakeNamespaces([{ name: "preview-acme-web-pr-2", createdAt: ANCIENT }]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.reaped).toBe(1);
            expect(cluster.deleted).toEqual(["preview-acme-web-pr-2"]);
            expect((await harness.statusOf(id)).status).toBe("torn_down");
        });

        test("leaves a namespace inside the TTL completely alone", async ({ harness }) => {
            const id = await harness.seedEnvironment("preview-acme-web-pr-3");
            const cluster = new FakeNamespaces([{ name: "preview-acme-web-pr-3", createdAt: FRESH }]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome).toMatchObject({ healthy: 1, reaped: 0, markedGone: 0 });
            expect(cluster.deleted).toEqual([]);
            expect((await harness.statusOf(id)).status).toBe("ready");
        });

        /** The base preview has no pull request to close, so age is not a reason to take it. */
        test("never reaps the base preview, however old", async ({ harness }) => {
            const id = await harness.seedEnvironment("preview-acme-web-pr-0");
            const cluster = new FakeNamespaces([{ name: "preview-acme-web-pr-0", createdAt: ANCIENT }]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.reaped).toBe(0);
            expect(cluster.deleted).toEqual([]);
            expect((await harness.statusOf(id)).status).toBe("ready");
        });

        /**
         * The shell cron deleted by age alone, so it also collected namespaces no row
         * accounted for. Without this the replacement would leave them running.
         */
        test("deletes an expired namespace that no live row accounts for", async ({ harness }) => {
            const cluster = new FakeNamespaces([{ name: "preview-orphan-pr-9", createdAt: ANCIENT }]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.deletedWithoutRow).toBe(1);
            expect(cluster.deleted).toEqual(["preview-orphan-pr-9"]);
        });

        test("a dry run reports the same work and performs none of it", async ({ harness }) => {
            const gone = await harness.seedEnvironment("preview-acme-web-pr-4");
            const expired = await harness.seedEnvironment("preview-acme-web-pr-5");
            const cluster = new FakeNamespaces([
                { name: "preview-acme-web-pr-5", createdAt: ANCIENT },
                { name: "preview-orphan-pr-6", createdAt: ANCIENT },
            ]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW, { dryRun: true });

            expect(outcome).toMatchObject({ markedGone: 1, reaped: 1, deletedWithoutRow: 1 });
            expect(cluster.deleted).toEqual([]);
            expect((await harness.statusOf(gone)).status).toBe("ready");
            expect((await harness.statusOf(expired)).status).toBe("ready");
        });

        test("an already torn-down row is not looked at again", async ({ harness }) => {
            const id = await harness.seedEnvironment("preview-acme-web-pr-7");
            await harness.db.previewkitEnvironment.update({
                where: { id },
                data: { status: "torn_down", tornDownAt: new Date() },
            });

            const outcome = await new PreviewReaper(harness.db, new FakeNamespaces([])).run(NOW);

            expect(outcome).toMatchObject({ markedGone: 0, reaped: 0, healthy: 0 });
        });
    },
});
