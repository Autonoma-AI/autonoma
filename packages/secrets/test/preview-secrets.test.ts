import { expect } from "vitest";
import { mintSecretKey } from "../src/mint-secret-key";
import { PreviewSecrets } from "../src/preview-secrets";
import { SecretKeys } from "../src/secret-keys";
import { SecretValues } from "../src/secret-values";
import { type SecretsHarness, secretsSuite } from "./harness";

const REPO = "acme/widgets";
const REPO_ID = 4242;

/** Stands in for AWS Secrets Manager, recording the ids it was asked for. */
class RecordingAws {
    readonly asked: string[] = [];

    constructor(private readonly secrets: Record<string, Record<string, string>> = {}) {}

    async send(command: { input: { SecretId?: string } }): Promise<{ SecretString?: string }> {
        const secretId = command.input.SecretId ?? "";
        this.asked.push(secretId);

        const found = this.secrets[secretId];
        if (found == null) throw new Error(`ResourceNotFoundException: ${secretId}`);
        return { SecretString: JSON.stringify(found) };
    }
}

interface SeedOptions {
    apps: string[];
    sealed?: Record<string, Record<string, string>>;
    githubRepositoryId?: number;
}

secretsSuite({
    name: "PreviewSecrets",
    cases: (test) => {
        /** An Application with a secret row per named app, sealing whichever `sealed` names. */
        async function seedApp(harness: SecretsHarness, options: SeedOptions): Promise<{ applicationId: string }> {
            const organization = await harness.db.organization.create({
                data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
            });
            const application = await harness.db.application.create({
                data: {
                    name: `App ${crypto.randomUUID()}`,
                    slug: `app-${crypto.randomUUID()}`,
                    organizationId: organization.id,
                    architecture: "WEB",
                    githubRepositoryId: options.githubRepositoryId ?? REPO_ID,
                },
            });
            for (const appName of options.apps) {
                await harness.db.previewkitSecret.create({
                    data: {
                        applicationId: application.id,
                        appName,
                    },
                });
            }

            const values = new SecretValues(harness.db, new SecretKeys(harness.db, harness.provider));
            for (const [appName, items] of Object.entries(options.sealed ?? {})) {
                await values.put(
                    { kind: "app", applicationId: application.id, appName },
                    Object.entries(items).map(([key, value]) => ({ key, value })),
                );
            }
            return { applicationId: application.id };
        }

        function reader(harness: SecretsHarness, aws: RecordingAws): PreviewSecrets {
            return new PreviewSecrets(
                aws,
                harness.db,
                new SecretValues(harness.db, new SecretKeys(harness.db, harness.provider)),
            );
        }

        function target(applicationId: string) {
            return { applicationId, repoFullName: REPO };
        }

        test("reads the sealed preview env without asking AWS", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, {
                apps: ["web"],
                sealed: { web: { API_KEY: "sealed", DEBUG: "1" } },
            });
            const aws = new RecordingAws();

            const values = await reader(harness, aws).getEnvValues(target(applicationId));

            expect(values).toEqual({ API_KEY: "sealed", DEBUG: "1" });
            expect(aws.asked).toEqual([]);
        });

        test("lists the env-var names without decrypting anything", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, {
                apps: ["web"],
                sealed: { web: { STRIPE_KEY: "sk_live", DATABASE_URL: "postgres://x" } },
            });
            const unwrapsAfterSeeding = harness.provider.unwrapped.length;

            const names = await reader(harness, new RecordingAws()).getEnvVarNames(target(applicationId));

            expect(names).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
            // Asking which names exist must not make a plaintext value materialize: the
            // stored key columns answer it, so no key is unwrapped and nothing decrypts.
            expect(harness.provider.unwrapped).toHaveLength(unwrapsAfterSeeding);
        });

        test("resolves the sole registered app even when it is not named web", async ({ harness }) => {
            // The name-based fallback builds previewkit/<repo>/web, so this preview
            // throws ResourceNotFoundException at the caller today.
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, {
                apps: ["storefront"],
                sealed: { storefront: { TOKEN: "t" } },
            });

            const values = await reader(harness, new RecordingAws()).getEnvValues(target(applicationId));

            expect(values).toEqual({ TOKEN: "t" });
        });

        test("prefers web when the Application registers several apps", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, {
                apps: ["api", "web"],
                sealed: { api: { WHICH: "api" }, web: { WHICH: "web" } },
            });

            const values = await reader(harness, new RecordingAws()).getEnvValues(target(applicationId));

            expect(values).toEqual({ WHICH: "web" });
        });

        test("never crosses to another Application sharing the repo name and id", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            // Two organizations onboarding the same GitHub repo is representable, so the
            // read is keyed on the Application the caller states - resolving the tenant
            // from the repo name would have to guess between these two.
            const theirs = await seedApp(harness, { apps: ["web"], sealed: { web: { OWNER: "theirs" } } });
            const mine = await seedApp(harness, { apps: ["web"], sealed: { web: { OWNER: "mine" } } });
            const client = reader(harness, new RecordingAws());

            expect(await client.getEnvValues(target(mine.applicationId))).toEqual({ OWNER: "mine" });
            expect(await client.getEnvValues(target(theirs.applicationId))).toEqual({ OWNER: "theirs" });
        });

        test("falls back to AWS for a preview Postgres holds nothing for", async ({ harness }) => {
            const { applicationId } = await seedApp(harness, { apps: ["web"] });
            const aws = new RecordingAws({ [`previewkit/${REPO}/web`]: { API_KEY: "from-aws" } });

            const values = await reader(harness, aws).getEnvValues(target(applicationId));

            expect(values).toEqual({ API_KEY: "from-aws" });
            expect(aws.asked).toEqual([`previewkit/${REPO}/web`]);
        });

        test("falls back to AWS for an Application with no registered secret at all", async ({ harness }) => {
            const aws = new RecordingAws({ [`previewkit/${REPO}/web`]: { API_KEY: "from-aws" } });

            const values = await reader(harness, aws).getEnvValues(target("app_missing"));

            expect(values).toEqual({ API_KEY: "from-aws" });
        });

        test("falls back to AWS when listing names finds nothing in Postgres", async ({ harness }) => {
            const { applicationId } = await seedApp(harness, { apps: ["web"] });
            const aws = new RecordingAws({ [`previewkit/${REPO}/web`]: { API_KEY: "from-aws" } });

            const names = await reader(harness, aws).getEnvVarNames(target(applicationId));

            expect(names).toEqual(["API_KEY"]);
        });

        test("reads AWS when this environment has no key to open postgres with", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, { apps: ["web"], sealed: { web: { API_KEY: "sealed" } } });
            const aws = new RecordingAws({ [`previewkit/${REPO}/web`]: { API_KEY: "from-aws" } });

            const values = await new PreviewSecrets(aws, harness.db).getEnvValues(target(applicationId));

            expect(values).toEqual({ API_KEY: "from-aws" });
        });
    },
});
