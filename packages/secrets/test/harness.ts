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

        // Values first: their encryptionKey FK is Restrict, so key rows cannot go while
        // any value still references one - which is the point of that constraint.
        await this.db.previewkitSecretValue.deleteMany();
        await this.db.previewkitOrgSecretValue.deleteMany();
        await this.db.previewkitEncryptionKey.deleteMany();
        await this.db.previewkitSecret.deleteMany();
        await this.db.previewkitOrgSecret.deleteMany();
        await this.db.application.deleteMany();
        await this.db.organization.deleteMany();
    }

    async afterEach() {
        // No-op
    }

    /** An app-scoped bundle with its `previewkit_secret` parent row registered. */
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
        await this.db.previewkitSecret.create({
            data: { applicationId: application.id, appName, awsSecretArn: `arn:aws:secretsmanager:::${appName}` },
        });

        return { kind: "app", applicationId: application.id, appName };
    }

    /** An org-scoped bundle with its `previewkit_org_secret` parent row registered. */
    async createOrgBundle(name = "neon"): Promise<OrgBundle> {
        const organizationId = await this.createOrg();
        await this.db.previewkitOrgSecret.create({
            data: { organizationId, name, awsSecretArn: `arn:aws:secretsmanager:::${name}` },
        });

        return { kind: "org", organizationId, name };
    }

    private async createOrg(): Promise<string> {
        const org = await this.db.organization.create({
            data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
        });
        return org.id;
    }
}

type AppBundle = { kind: "app"; applicationId: string; appName: string };
type OrgBundle = { kind: "org"; organizationId: string; name: string };

type SecretsSuiteContext = { harness: SecretsHarness; seedResult: undefined };

export function secretsSuite({ name, cases }: { name: string; cases: (test: TestAPI<SecretsSuiteContext>) => void }) {
    integrationTestSuite<SecretsHarness, undefined>({
        name,
        createHarness: () => SecretsHarness.create(),
        seed: async () => undefined,
        cases,
    });
}
