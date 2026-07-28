import { type IntegrationHarness, integrationTestSuite, stopContainer } from "@autonoma/integration-test";
import { CreateAliasCommand, CreateKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { TestAPI } from "vitest";

/**
 * MiniStack (MIT, github.com/ministackorg/ministack) emulates the two KMS calls
 * previewkit secrets make. Pinned: this verifies real AWS SDK wiring, so an
 * emulator changing behaviour under us would be a confusing test failure.
 */
const MINISTACK_IMAGE = "ministackorg/ministack:1.4.7";
const MINISTACK_PORT = 4566;

export const CMK_ALIAS = "alias/previewkit-secrets-test";

export class KmsHarness implements IntegrationHarness {
    constructor(
        public readonly kms: KMSClient,
        private readonly container: StartedTestContainer,
    ) {}

    static async create(): Promise<KmsHarness> {
        const container = await new GenericContainer(MINISTACK_IMAGE)
            .withExposedPorts(MINISTACK_PORT)
            .withWaitStrategy(Wait.forHealthCheck())
            .start();

        const kms = new KMSClient({
            region: "us-east-1",
            endpoint: `http://${container.getHost()}:${container.getMappedPort(MINISTACK_PORT)}`,
            credentials: { accessKeyId: "test", secretAccessKey: "test" },
        });

        const created = await kms.send(new CreateKeyCommand({ Description: "previewkit secrets tests" }));
        await kms.send(new CreateAliasCommand({ AliasName: CMK_ALIAS, TargetKeyId: created.KeyMetadata?.Arn }));

        return new KmsHarness(kms, container);
    }

    async beforeAll() {
        // No-op - the harness is ready after create()
    }

    async afterAll() {
        await stopContainer(this.container);
    }

    async beforeEach() {
        // No-op - KMS state is not mutated by these cases
    }

    async afterEach() {
        // No-op
    }
}

type KmsSuiteContext = { harness: KmsHarness; seedResult: undefined };

export function kmsSuite({ name, cases }: { name: string; cases: (test: TestAPI<KmsSuiteContext>) => void }) {
    integrationTestSuite<KmsHarness, undefined>({
        name,
        createHarness: () => KmsHarness.create(),
        seed: async () => undefined,
        cases,
    });
}
