import { integrationTestSuite } from "@autonoma/integration-test";
import { mintSecretKey, SecretKeys, SecretValues } from "@autonoma/secrets";
import { FakeKeyProvider } from "@autonoma/secrets/fake-key-provider";
import { ApiException, type V1Secret } from "@kubernetes/client-node";
import { expect } from "vitest";
import { PostgresSecretMaterializer, type SecretWriter } from "../../src/secrets/postgres-secret-materializer";
import { previewSecretName } from "../../src/secrets/preview-secret-name";
import { RuntimeSecrets } from "../../src/secrets/runtime-secrets";
import { PreviewkitTestHarness } from "./harness";

const NAMESPACE = "preview-acme-widgets-pr-42";
const REPO_ID = 991_234;

/** Stands in for the Kubernetes API, recording what would have been written. */
class RecordingWriter implements SecretWriter {
    readonly written: V1Secret[] = [];

    constructor(
        /** Names that already exist; a replace of anything else 404s the way the API does. */
        private readonly existing = new Set<string>(),
    ) {}

    async replaceNamespacedSecret(params: { name: string; namespace: string; body: V1Secret }) {
        if (!this.existing.has(params.name)) throw notFound();
        this.written.push(params.body);
        return this.stamped(params.body);
    }

    async createNamespacedSecret(params: { namespace: string; body: V1Secret }) {
        this.existing.add(params.body.metadata?.name ?? "");
        this.written.push(params.body);
        return this.stamped(params.body);
    }

    private stamped(body: V1Secret): V1Secret {
        return { ...body, metadata: { ...body.metadata, resourceVersion: "1001" } };
    }
}

/** The client's own 404 - `isNotFound` checks the type, not just the code. */
function notFound(): ApiException<string> {
    return new ApiException(404, "secrets not found", "", {});
}

integrationTestSuite<PreviewkitTestHarness, undefined>({
    name: "RuntimeSecrets",
    createHarness: () => PreviewkitTestHarness.create(),
    seed: async () => undefined,
    cases: (test) => {
        /** An Application holding a sealed bundle per app named in `sealed`. */
        async function seedApps(
            harness: PreviewkitTestHarness,
            sealed: Record<string, Record<string, string>>,
        ): Promise<{ organizationId: string; applicationId: string }> {
            const { organizationId } = await harness.createOrganization();
            const application = await harness.db.application.create({
                data: {
                    name: `App ${crypto.randomUUID()}`,
                    slug: `app-${crypto.randomUUID()}`,
                    organizationId,
                    architecture: "WEB",
                    githubRepositoryId: REPO_ID,
                },
            });
            if (Object.keys(sealed).length > 0) {
                // A secret is sealed against its app row, so each named app has to be
                // in the topology before anything can be stored for it.
                await harness.createTopology(organizationId, REPO_ID, Object.keys(sealed));
                const provider = new FakeKeyProvider();
                await mintSecretKey({ db: harness.db, provider, keyId: "1" });
                const values = new SecretValues(harness.db, new SecretKeys(harness.db, provider));
                for (const [appName, items] of Object.entries(sealed)) {
                    await values.put(
                        { kind: "app", applicationId: application.id, appName },
                        Object.entries(items).map(([key, value]) => ({ key, value })),
                    );
                }
            }
            return { organizationId, applicationId: application.id };
        }

        function materializer(harness: PreviewkitTestHarness, writer: SecretWriter, released: string[][] = []) {
            return new PostgresSecretMaterializer(
                writer,
                new SecretValues(harness.db, new SecretKeys(harness.db, new FakeKeyProvider())),
                async (_namespace, secretNames) => {
                    released.push(secretNames);
                },
            );
        }

        test("writes the K8s Secret from the sealed values", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, {
                web: { AUTONOMA_SHARED_SECRET: "shhh", DATABASE_URL: "postgres://x" },
            });
            const writer = new RecordingWriter();

            const result = await new RuntimeSecrets(materializer(harness, writer), harness.db).applyForNamespace(
                organizationId,
                REPO_ID,
                NAMESPACE,
                ["web"],
            );

            expect(result.get("web")).toEqual({ secretName: "web-secrets", secretVersion: "1001" });
            expect(writer.written[0]?.stringData).toEqual({
                AUTONOMA_SHARED_SECRET: "shhh",
                DATABASE_URL: "postgres://x",
            });
        });

        test("releases the ExternalSecret owning a target before writing it", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, { web: { TOKEN: "t" } });
            const released: string[][] = [];
            // The Secret already exists, as it does in a namespace deployed before the
            // cutover: that is the case the release exists for.
            const writer = new RecordingWriter(new Set(["web-secrets"]));

            await new RuntimeSecrets(materializer(harness, writer, released), harness.db).applyForNamespace(
                organizationId,
                REPO_ID,
                NAMESPACE,
                ["web"],
            );

            expect(released).toEqual([["web-secrets"]]);
            // Clearing ownerReferences is what stops the garbage collector deleting the
            // Secret out from under the preview once its ExternalSecret goes.
            expect(writer.written[0]?.metadata?.ownerReferences).toEqual([]);
        });

        test("fails the deploy when a stored app's Secret cannot be written", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, { web: { TOKEN: "t" }, api: { TOKEN: "t" } });
            // `api` holds a row that cannot be opened - the shape a botched key rotation
            // or a partial restore leaves behind. There is no ESO to fall through to any
            // more, and rolling out an app whose Secret was never populated brings it up
            // "ready" against missing credentials.
            await harness.db.previewkitSecret.updateMany({
                where: { app: { name: "api" } },
                data: { envelope: "v1.1.bm90LWFuLWVudmVsb3Bl" },
            });

            await expect(
                new RuntimeSecrets(materializer(harness, new RecordingWriter()), harness.db).applyForNamespace(
                    organizationId,
                    REPO_ID,
                    NAMESPACE,
                    ["web", "api"],
                ),
            ).rejects.toThrow(/api/);
        });

        test("returns nothing when no app holds a secret", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, {});

            const result = await new RuntimeSecrets(
                materializer(harness, new RecordingWriter()),
                harness.db,
            ).applyForNamespace(organizationId, REPO_ID, NAMESPACE, ["web"]);

            expect(result.size).toBe(0);
        });

        test("fails when stored bundles exist but the environment has no encryption key", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, { web: { TOKEN: "t" } });

            await expect(
                new RuntimeSecrets(undefined, harness.db).applyForNamespace(organizationId, REPO_ID, NAMESPACE, [
                    "web",
                ]),
            ).rejects.toThrow(/PREVIEWKIT_SECRETS_CMK/);
        });

        test("ignores an app of the same name registered under another Application", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, { web: { TOKEN: "mine" } });
            // Same org, same app name, different repo - a bare appName match would mount
            // this foreign application's secret into the namespace.
            const other = await harness.db.application.create({
                data: {
                    name: `Other ${crypto.randomUUID()}`,
                    slug: `other-${crypto.randomUUID()}`,
                    organizationId,
                    architecture: "WEB",
                    githubRepositoryId: REPO_ID + 1,
                },
            });
            // The foreign application needs its own topology naming "web", or its
            // secret cannot be sealed - which would make this test pass for the wrong
            // reason (nothing to mount rather than nothing mounted).
            await harness.createTopology(organizationId, REPO_ID + 1, ["web"]);
            await new SecretValues(harness.db, new SecretKeys(harness.db, new FakeKeyProvider())).put(
                { kind: "app", applicationId: other.id, appName: "web" },
                [{ key: "TOKEN", value: "theirs" }],
            );

            const writer = new RecordingWriter();
            const result = await new RuntimeSecrets(materializer(harness, writer), harness.db).applyForNamespace(
                organizationId,
                REPO_ID,
                NAMESPACE,
                ["web"],
            );

            expect(result.size).toBe(1);
            expect(writer.written[0]?.stringData).toEqual({ TOKEN: "mine" });
        });

        test("derives the same Secret name the deployer mounts", () => {
            expect(previewSecretName("Web App")).toBe("web-app-secrets");
        });
    },
});
