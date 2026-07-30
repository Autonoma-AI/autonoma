import { integrationTestSuite } from "@autonoma/integration-test";
import { mintSecretKey, SecretKeys, SecretValues } from "@autonoma/secrets";
import { FakeKeyProvider } from "@autonoma/secrets/fake-key-provider";
import { ApiException, type V1Secret } from "@kubernetes/client-node";
import { expect } from "vitest";
import { PostgresSecretMaterializer, type SecretWriter } from "../../src/secrets/postgres-secret-materializer";
import { previewSecretName } from "../../src/secrets/preview-secret-name";
import type {
    AppSecretInfo,
    RuntimeSecretMaterializer,
    SecretTarget,
} from "../../src/secrets/runtime-secret-materializer";
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
        /** A response with no resourceVersion, which the deploy must refuse to roll out on. */
        private readonly omitResourceVersion = false,
    ) {}

    async replaceNamespacedSecret(params: { name: string; namespace: string; body: V1Secret }) {
        if (!this.existing.has(params.name)) throw notFound();
        this.written.push(params.body);
        return this.stamped(params.body);
    }

    async createNamespacedSecret(params: { namespace: string; body: V1Secret }) {
        const name = params.body.metadata?.name ?? "";
        this.existing.add(name);
        this.written.push(params.body);
        return this.stamped(params.body);
    }

    private stamped(body: V1Secret): V1Secret {
        if (this.omitResourceVersion) return body;
        return { ...body, metadata: { ...body.metadata, resourceVersion: "1001" } };
    }
}

/** The client's own 404 - `isNotFound` checks the type, not just the code. */
function notFound(): ApiException<string> {
    return new ApiException(404, "secrets not found", "", {});
}

/** Stands in for the ESO path, so a fallback is visible without a cluster. */
class RecordingEso implements RuntimeSecretMaterializer {
    readonly seen: string[][] = [];

    async materialize(_namespace: string, _organizationId: string, targets: SecretTarget[]) {
        this.seen.push(targets.map((target) => target.record.appName));
        return new Map<string, AppSecretInfo>(
            targets.map((target) => [target.record.appName, { secretName: target.secretName, secretVersion: "eso-1" }]),
        );
    }
}

integrationTestSuite<PreviewkitTestHarness, undefined>({
    name: "RuntimeSecrets",
    createHarness: () => PreviewkitTestHarness.create(),
    seed: async () => undefined,
    cases: (test) => {
        /**
         * An Application with one secret row per named app, and sealed values for
         * whichever of them `sealed` names.
         */
        async function seedApps(
            harness: PreviewkitTestHarness,
            apps: string[],
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
            for (const appName of apps) {
                await harness.db.previewkitSecret.create({
                    data: {
                        applicationId: application.id,
                        appName,
                        awsSecretArn: `arn:aws:secretsmanager:::${appName}`,
                    },
                });
            }

            if (Object.keys(sealed).length > 0) {
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

        function postgres(harness: PreviewkitTestHarness, writer: SecretWriter, released: string[][] = []) {
            return new PostgresSecretMaterializer(
                writer,
                new SecretValues(harness.db, new SecretKeys(harness.db, new FakeKeyProvider())),
                async (_namespace, secretNames) => {
                    released.push(secretNames);
                },
            );
        }

        test("writes the K8s Secret from the sealed values and never reaches ESO", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, ["web"], {
                web: { AUTONOMA_SHARED_SECRET: "shhh", DATABASE_URL: "postgres://x" },
            });
            const writer = new RecordingWriter();
            const eso = new RecordingEso();

            const result = await new RuntimeSecrets(eso, postgres(harness, writer), harness.db).applyForNamespace(
                organizationId,
                REPO_ID,
                NAMESPACE,
                ["web"],
            );

            expect(result.get("web")).toEqual({ secretName: "web-secrets", secretVersion: "1001" });
            expect(writer.written).toHaveLength(1);
            expect(writer.written[0]?.stringData).toEqual({
                AUTONOMA_SHARED_SECRET: "shhh",
                DATABASE_URL: "postgres://x",
            });
            expect(writer.written[0]?.metadata?.name).toBe("web-secrets");
            // ESO was handed an empty set, so it applies no ExternalSecret at all.
            expect(eso.seen).toEqual([[]]);
        });

        test("releases ESO's ownership of a target before writing it", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, ["web"], { web: { TOKEN: "t" } });
            const released: string[][] = [];
            // The Secret already exists, as it does in a namespace ESO has been
            // populating: the handoff has to happen there, not just on a fresh one.
            const writer = new RecordingWriter(new Set(["web-secrets"]));

            await new RuntimeSecrets(
                new RecordingEso(),
                postgres(harness, writer, released),
                harness.db,
            ).applyForNamespace(organizationId, REPO_ID, NAMESPACE, ["web"]);

            expect(released).toEqual([["web-secrets"]]);
            // Clearing the ownerReferences is what keeps the garbage collector from
            // deleting the Secret out from under the preview after the ES goes.
            expect(writer.written[0]?.metadata?.ownerReferences).toEqual([]);
        });

        test("leaves an un-backfilled app on ESO while writing the one it can", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, ["web", "api"], { web: { TOKEN: "t" } });
            const writer = new RecordingWriter();
            const eso = new RecordingEso();

            const result = await new RuntimeSecrets(eso, postgres(harness, writer), harness.db).applyForNamespace(
                organizationId,
                REPO_ID,
                NAMESPACE,
                ["web", "api"],
            );

            expect(result.get("web")?.secretVersion).toBe("1001");
            expect(result.get("api")?.secretVersion).toBe("eso-1");
            expect(eso.seen).toEqual([["api"]]);
            expect(writer.written.map((secret) => secret.metadata?.name)).toEqual(["web-secrets"]);
        });

        test("uses ESO for every app when this environment has not flipped", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, ["web"], { web: { TOKEN: "t" } });
            const eso = new RecordingEso();

            const result = await new RuntimeSecrets(eso, undefined, harness.db).applyForNamespace(
                organizationId,
                REPO_ID,
                NAMESPACE,
                ["web"],
            );

            expect(result.get("web")?.secretVersion).toBe("eso-1");
            expect(eso.seen).toEqual([["web"]]);
        });

        test("fails the deploy when the written Secret comes back with no resourceVersion", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, ["web"], { web: { TOKEN: "t" } });
            const writer = new RecordingWriter(new Set(), true);

            await expect(
                new RuntimeSecrets(new RecordingEso(), postgres(harness, writer), harness.db).applyForNamespace(
                    organizationId,
                    REPO_ID,
                    NAMESPACE,
                    ["web"],
                ),
            ).rejects.toThrow(/resourceVersion/);
        });

        test("ignores an app of the same name registered under another Application", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, ["web"], { web: { TOKEN: "mine" } });
            // Same org, same app name, different repo - a bare appName match would
            // mount this foreign application's secret into the namespace.
            const other = await harness.db.application.create({
                data: {
                    name: `Other ${crypto.randomUUID()}`,
                    slug: `other-${crypto.randomUUID()}`,
                    organizationId,
                    architecture: "WEB",
                    githubRepositoryId: REPO_ID + 1,
                },
            });
            await harness.db.previewkitSecret.create({
                data: { applicationId: other.id, appName: "web", awsSecretArn: "arn:aws:secretsmanager:::other" },
            });

            const writer = new RecordingWriter();
            const result = await new RuntimeSecrets(
                new RecordingEso(),
                postgres(harness, writer),
                harness.db,
            ).applyForNamespace(organizationId, REPO_ID, NAMESPACE, ["web"]);

            expect(result.size).toBe(1);
            expect(writer.written).toHaveLength(1);
            expect(writer.written[0]?.stringData).toEqual({ TOKEN: "mine" });
        });

        test("returns nothing when no app has a registered secret", async ({ harness }) => {
            const { organizationId } = await seedApps(harness, [], {});
            const eso = new RecordingEso();

            const result = await new RuntimeSecrets(eso, undefined, harness.db).applyForNamespace(
                organizationId,
                REPO_ID,
                NAMESPACE,
                ["web"],
            );

            expect(result.size).toBe(0);
            // No rows means no work handed to either store.
            expect(eso.seen).toEqual([]);
        });

        test("derives the same Secret name the deployer mounts", () => {
            expect(previewSecretName("Web App")).toBe("web-app-secrets");
        });
    },
});
