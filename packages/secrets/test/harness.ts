import { createClient, type PrismaClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import type { TestAPI } from "vitest";
import { keyEncryptionContext } from "../src/key-encryption-context";
import { FakeKeyProvider } from "./fake-key-provider";

export class SecretsHarness implements IntegrationHarness {
    /** Rebuilt per test so key-provider call counts start clean. */
    public provider = new FakeKeyProvider();

    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<SecretsHarness> {
        const connectionUri = await createTestDatabase();
        return new SecretsHarness(createClient(connectionUri));
    }

    async beforeAll() {
        // No-op - the harness is ready after create()
    }

    async afterAll() {
        await this.db.$disconnect();
    }

    async beforeEach() {
        this.provider = new FakeKeyProvider();

        // Secrets first: their encryptionKey FK is Restrict, so key rows cannot go while
        // any value still references one - which is the point of that constraint.
        await this.db.previewkitSecret.deleteMany();
        await this.db.previewkitApp.deleteMany();
        await this.db.previewkitConfig.deleteMany();
        await this.db.previewkitEncryptionKey.deleteMany();
        await this.db.application.deleteMany();
        await this.db.organization.deleteMany();
    }

    async afterEach() {
        // No-op
    }

    /**
     * An app-scoped bundle identity, with the Application AND the preview topology
     * its rows hang off. The app row is not optional scaffolding: a secret is sealed
     * against it, so a bundle whose app is not in the topology has nowhere to store
     * anything and `SecretValues` refuses it.
     */
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
        const appId = await this.createTopologyApp(application.id, appName);

        // Carries the app id so a test can open a value the way the store does -
        // against the row the envelope was sealed under.
        return { kind: "app", applicationId: application.id, appName, appId };
    }

    /**
     * The raw material behind a stored encryption key. Only a migration test needs
     * this - it is how you build a cipher that seals the OLD envelope version, which
     * nothing in the codebase can do any more.
     */
    async keyMaterial(keyId: string): Promise<Uint8Array> {
        const row = await this.db.previewkitEncryptionKey.findUniqueOrThrow({
            where: { id: keyId },
            select: { wrap: true },
        });
        return this.provider.unwrap(row.wrap, keyEncryptionContext(keyId));
    }

    /** Adds `appName` to the application's preview topology, creating the config if needed. */
    async createTopologyApp(applicationId: string, appName: string): Promise<string> {
        const config = await this.db.previewkitConfig.upsert({
            where: { applicationId },
            create: { applicationId },
            update: {},
            select: { id: true },
        });
        const app = await this.db.previewkitApp.create({
            data: {
                configId: config.id,
                position: 0,
                name: appName,
                repository: "acme/web",
                path: ".",
                port: 3000,
                resourcesTier: "medium",
            },
            select: { id: true },
        });
        return app.id;
    }

    private async createOrg(): Promise<string> {
        const org = await this.db.organization.create({
            data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
        });
        return org.id;
    }
}

type AppBundle = { kind: "app"; applicationId: string; appName: string; appId: string };

type SecretsSuiteContext = { harness: SecretsHarness; seedResult: undefined };

export function secretsSuite({ name, cases }: { name: string; cases: (test: TestAPI<SecretsSuiteContext>) => void }) {
    integrationTestSuite<SecretsHarness, undefined>({
        name,
        createHarness: () => SecretsHarness.create(),
        seed: async () => undefined,
        cases,
    });
}
