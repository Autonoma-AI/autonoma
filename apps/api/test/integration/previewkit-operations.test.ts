import { mintSecretKey, SecretKeys, SecretValues } from "@autonoma/secrets";
import { FakeKeyProvider } from "@autonoma/secrets/fake-key-provider";
import type { PreviewkitOperation } from "@autonoma/types";
import { expect } from "vitest";
import { PreviewkitOperationsService } from "../../src/previewkit/previewkit-operations.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

/** Two apps, one of which the rename tests move. */
function document(apps: Array<{ name: string; port?: number }>) {
    return {
        version: 2,
        apps: apps.map((app) => ({
            name: app.name,
            repository: "acme/web",
            path: ".",
            port: app.port ?? 3000,
        })),
    };
}

function replace(apps: Array<{ name: string; port?: number }>): PreviewkitOperation {
    return { op: "replaceConfig", document: document(apps) };
}

apiTestSuite({
    name: "previewkit-operations",
    cases: (test) => {
        async function setup(harness: APITestHarness) {
            await harness.db.previewkitSecret.deleteMany();
            await harness.db.previewkitEncryptionKey.deleteMany();

            const provider = new FakeKeyProvider();
            await mintSecretKey({ db: harness.db, provider, keyId: "1" });
            const keys = new SecretKeys(harness.db, provider);

            const application = await harness.db.application.create({
                data: {
                    name: `App ${crypto.randomUUID()}`,
                    slug: `app-${crypto.randomUUID()}`,
                    organizationId: harness.organizationId,
                    architecture: "WEB",
                },
            });

            return {
                applicationId: application.id,
                keys,
                values: new SecretValues(harness.db, keys),
                service: new PreviewkitOperationsService(harness.db, keys),
            };
        }

        async function appRow(harness: APITestHarness, applicationId: string, name: string) {
            return await harness.db.previewkitApp.findFirstOrThrow({
                where: { name, config: { applicationId } },
                select: { id: true, name: true },
            });
        }

        /**
         * The reason this API exists. Under a document-only write a rename is a delete
         * plus a create, and the secrets and build history cascade away with the old
         * row - so this asserts the row ID itself is unchanged, not merely that a
         * secret with the same value exists afterwards.
         */
        test("a rename keeps the app row, its secrets and its build history", async ({ harness }) => {
            const { applicationId, service, values } = await setup(harness);

            await service.apply(applicationId, harness.organizationId, [replace([{ name: "web" }])]);
            const before = await appRow(harness, applicationId, "web");
            await values.put({ kind: "app", applicationId, appName: "web" }, [
                { key: "DATABASE_URL", value: "postgres://secret" },
            ]);

            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    organizationId: harness.organizationId,
                    namespace: `preview-rename-${crypto.randomUUID().slice(0, 8)}`,
                    repoFullName: "acme/web",
                    prNumber: 1,
                    headSha: "sha",
                    headRef: "branch",
                    status: "ready",
                },
            });
            await harness.db.previewkitAppInstance.create({
                data: { environmentId: environment.id, appId: before.id, appName: "web", status: "ready", port: 3000 },
            });

            await service.apply(applicationId, harness.organizationId, [
                { op: "renameApp", appId: before.id, name: "frontend" },
                replace([{ name: "frontend" }]),
            ]);

            const after = await appRow(harness, applicationId, "frontend");
            expect(after.id).toBe(before.id);
            expect(await values.get({ kind: "app", applicationId, appName: "frontend" }, "DATABASE_URL")).toBe(
                "postgres://secret",
            );
            expect(await harness.db.previewkitAppInstance.count({ where: { appId: before.id } })).toBe(1);
        });

        /**
         * Ordering is the contract. The same two edits with the document first look
         * to the server like "web is gone, frontend is new".
         */
        test("the document alone, without the rename, destroys the app", async ({ harness }) => {
            const { applicationId, service, values } = await setup(harness);

            await service.apply(applicationId, harness.organizationId, [replace([{ name: "web" }])]);
            const before = await appRow(harness, applicationId, "web");
            await values.put({ kind: "app", applicationId, appName: "web" }, [{ key: "API_KEY", value: "sk" }]);

            const result = await service.apply(applicationId, harness.organizationId, [
                replace([{ name: "frontend" }]),
            ]);

            expect(result.deletedApps).toEqual(["web"]);
            const after = await appRow(harness, applicationId, "frontend");
            expect(after.id).not.toBe(before.id);
            expect(await harness.db.previewkitSecret.count({ where: { appId: before.id } })).toBe(0);
        });

        /**
         * `(configId, name)` is unique and checked per statement, so renaming into a
         * name another app still holds fails even when the end state is legal.
         */
        test("two apps can swap names in one call", async ({ harness }) => {
            const { applicationId, service } = await setup(harness);

            await service.apply(applicationId, harness.organizationId, [replace([{ name: "web" }, { name: "api" }])]);
            const web = await appRow(harness, applicationId, "web");
            const api = await appRow(harness, applicationId, "api");

            await service.apply(applicationId, harness.organizationId, [
                { op: "renameApp", appId: web.id, name: "api" },
                { op: "renameApp", appId: api.id, name: "web" },
                replace([{ name: "api" }, { name: "web" }]),
            ]);

            expect((await appRow(harness, applicationId, "api")).id).toBe(web.id);
            expect((await appRow(harness, applicationId, "web")).id).toBe(api.id);
        });

        test("a secret can be set for an app the same call creates", async ({ harness }) => {
            const { applicationId, service, values } = await setup(harness);

            await service.apply(applicationId, harness.organizationId, [
                replace([{ name: "web" }]),
                { op: "setSecret", app: "web", key: "TOKEN", value: "t0ken" },
            ]);

            expect(await values.get({ kind: "app", applicationId, appName: "web" }, "TOKEN")).toBe("t0ken");
        });

        test("deleteSecret removes just that key", async ({ harness }) => {
            const { applicationId, service, values } = await setup(harness);

            await service.apply(applicationId, harness.organizationId, [
                replace([{ name: "web" }]),
                { op: "setSecret", app: "web", key: "KEEP", value: "a" },
                { op: "setSecret", app: "web", key: "DROP", value: "b" },
                { op: "deleteSecret", app: "web", key: "DROP" },
            ]);

            const bundle = { kind: "app", applicationId, appName: "web" } as const;
            expect(await values.get(bundle, "KEEP")).toBe("a");
            expect(await values.get(bundle, "DROP")).toBeUndefined();
        });

        test("nothing is written when a later operation fails", async ({ harness }) => {
            const { applicationId, service } = await setup(harness);
            await service.apply(applicationId, harness.organizationId, [replace([{ name: "web" }])]);

            await expect(
                service.apply(applicationId, harness.organizationId, [
                    replace([{ name: "web" }, { name: "api" }]),
                    { op: "setSecret", app: "nope", key: "TOKEN", value: "t" },
                ]),
            ).rejects.toThrow(/not in the application's preview topology/);

            // The `api` the failed call would have added is not there.
            expect(await harness.db.previewkitApp.count({ where: { config: { applicationId } } })).toBe(1);
        });

        test("renaming an app that is not in this topology is a 404", async ({ harness }) => {
            const { applicationId, service } = await setup(harness);
            await service.apply(applicationId, harness.organizationId, [replace([{ name: "web" }])]);

            await expect(
                service.apply(applicationId, harness.organizationId, [
                    { op: "renameApp", appId: "pkapp_does_not_exist", name: "frontend" },
                ]),
            ).rejects.toThrow(/not in this application's preview topology/);
        });

        test("two documents in one list are refused rather than silently collapsed", async ({ harness }) => {
            const { applicationId, service } = await setup(harness);

            await expect(
                service.apply(applicationId, harness.organizationId, [
                    replace([{ name: "web" }]),
                    replace([{ name: "api" }]),
                ]),
            ).rejects.toThrow(/at most one replaceConfig/);
        });

        test("an application in another organization is a 404", async ({ harness }) => {
            const { applicationId, service } = await setup(harness);
            const other = await harness.db.organization.create({
                data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
            });

            await expect(service.apply(applicationId, other.id, [replace([{ name: "web" }])])).rejects.toThrow();
        });

        /**
         * The route, and the id that makes the editor's half of this possible: a
         * composed document carries each app's row id, which is how an editor tells
         * "this app was renamed" from "this app was replaced" and knows what to name
         * in a `renameApp`.
         */
        test("the route applies a rename and the read exposes the app row id", async ({ harness }) => {
            const { applicationId, service } = await setup(harness);
            // The read refuses an application with no repository. Allocated above the
            // high-water mark rather than at random: the suite shares an organization,
            // (org, repo) is unique, and a random id collides eventually.
            const highest = await harness.db.application.aggregate({ _max: { githubRepositoryId: true } });
            await harness.db.application.update({
                where: { id: applicationId },
                data: { githubRepositoryId: (highest._max.githubRepositoryId ?? 0) + 1 },
            });
            await service.apply(applicationId, harness.organizationId, [replace([{ name: "web" }])]);
            const before = await appRow(harness, applicationId, "web");

            await harness.request().onboarding.applyPreviewkitOperations({
                applicationId,
                operations: [{ op: "renameApp", appId: before.id, name: "frontend" }, replace([{ name: "frontend" }])],
            });

            const read = await harness.request().onboarding.getPreviewkitConfig({ applicationId });
            const app = read.document?.apps?.[0];
            expect(app?.name).toBe("frontend");
            expect(app?.id).toBe(before.id);
        });

        test("findApp resolves a name to its row, and refuses another tenant's", async ({ harness }) => {
            const { applicationId, service } = await setup(harness);
            await service.apply(applicationId, harness.organizationId, [replace([{ name: "web" }])]);
            const web = await appRow(harness, applicationId, "web");

            expect(await service.findApp(applicationId, harness.organizationId, "web")).toEqual({ id: web.id });

            const other = await harness.db.organization.create({
                data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
            });
            await expect(service.findApp(applicationId, other.id, "web")).rejects.toThrow(/No app named/);
            await expect(service.findApp(applicationId, harness.organizationId, "nope")).rejects.toThrow(
                /No app named/,
            );
        });

        /**
         * A config can be saved mid-edit. Refusing every invalid one would lock an
         * already-invalid config out of the edit that fixes it, so violations come
         * back as issues.
         */
        test("a semantically invalid config is saved and its issues reported", async ({ harness }) => {
            const { applicationId, service } = await setup(harness);

            const result = await service.apply(applicationId, harness.organizationId, [
                {
                    op: "replaceConfig",
                    document: {
                        version: 2,
                        apps: [
                            {
                                name: "web",
                                repository: "acme/web",
                                path: ".",
                                port: 3000,
                                depends_on: ["nothing-by-that-name"],
                            },
                        ],
                    },
                },
            ]);

            expect(result.issues.length).toBeGreaterThan(0);
            await expect(appRow(harness, applicationId, "web")).resolves.toBeTruthy();
        });
    },
});
