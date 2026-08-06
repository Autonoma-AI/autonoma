import { applyMigrations, createClient, type PrismaClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite, stopContainer } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestAPI } from "vitest";
import { FakeKeyProvider } from "./fake-key-provider";

const POSTGRES_IMAGE = "postgres:18-alpine";

export class SecretsHarness implements IntegrationHarness {
    /** Rebuilt per test so key-provider call counts start clean. */
    public provider = new FakeKeyProvider();

    constructor(
        public readonly db: PrismaClient,
        private readonly pgContainer: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<SecretsHarness> {
        const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pgContainer.getConnectionUri());
        return new SecretsHarness(createClient(pgContainer.getConnectionUri()), pgContainer);
    }

    async beforeAll() {
        // No-op - the harness is ready after create()
    }

    async afterAll() {
        await stopContainer(this.pgContainer);
    }

    async beforeEach() {
        this.provider = new FakeKeyProvider();

        // Secrets first: their encryptionKey FK is Restrict, so key rows cannot go while
        // any value still references one - which is the point of that constraint.
        await this.db.previewkitSecret.deleteMany();
        await this.db.previewkitEncryptionKey.deleteMany();
        await this.db.application.deleteMany();
        await this.db.organization.deleteMany();
    }

    async afterEach() {
        // No-op
    }

    /** An app-scoped bundle identity, with the Application its rows hang off. */
    async createAppBundle(appName = "web"): Promise<AppBundle> {
        const organizationId = await this.createOrg();
        const application = await this.db.application.create({
            data: {
                name: `App ${crypto.randomUUID()}`,
                slug: `app-${crypto.randomUUID()}`,
                organizationId,
                architecture: "WEB",
            },
        });

        return { kind: "app", applicationId: application.id, appName };
    }

    private async createOrg(): Promise<string> {
        const org = await this.db.organization.create({
            data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
        });
        return org.id;
    }
}

type AppBundle = { kind: "app"; applicationId: string; appName: string };

type SecretsSuiteContext = { harness: SecretsHarness; seedResult: undefined };

export function secretsSuite({ name, cases }: { name: string; cases: (test: TestAPI<SecretsSuiteContext>) => void }) {
    integrationTestSuite<SecretsHarness, undefined>({
        name,
        createHarness: () => SecretsHarness.create(),
        seed: async () => undefined,
        cases,
    });
}
