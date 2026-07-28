import { applyMigrations, createClient, type PrismaClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite, stopContainer } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestAPI } from "vitest";
import { FakeKeyProvider } from "./fake-key-provider";

const POSTGRES_IMAGE = "postgres:17-alpine";

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
        await this.db.previewkitSecretKey.deleteMany();
    }

    async afterEach() {
        // No-op
    }
}

type SecretsSuiteContext = { harness: SecretsHarness; seedResult: undefined };

export function secretsSuite({ name, cases }: { name: string; cases: (test: TestAPI<SecretsSuiteContext>) => void }) {
    integrationTestSuite<SecretsHarness, undefined>({
        name,
        createHarness: () => SecretsHarness.create(),
        seed: async () => undefined,
        cases,
    });
}
