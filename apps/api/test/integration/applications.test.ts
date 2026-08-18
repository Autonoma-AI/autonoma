import { ApplicationArchitecture } from "@autonoma/db";
import { mintSecretKey, SecretKeys, SecretValues } from "@autonoma/secrets";
import { FakeKeyProvider } from "@autonoma/secrets/fake-key-provider";
import { TRPCError } from "@trpc/server";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "applications",
    seed: async ({ harness }) => {
        const web = await harness.services.applications.createApplication({
            name: "My Web App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/default-file.png",
        });
        const ios = await harness.services.applications.createApplication({
            name: "My iOS App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.IOS,
            packageUrl: "s3://bucket/app.ipa",
            packageName: "com.example.app",
            photo: "s3://bucket/default-photo.png",
        });
        return { web, ios };
    },
    cases: (test) => {
        test("lists all applications", async ({ harness, seedResult: { web, ios } }) => {
            const list = await harness.request().applications.list();
            expect(list).toHaveLength(2);
            const ids = list.map((a) => a.id);
            expect(ids).toContain(web.id);
            expect(ids).toContain(ios.id);
        });

        test("excludes applications with no main branch from list", async ({ harness, seedResult: { web, ios } }) => {
            await harness.db.application.create({
                data: {
                    name: "Broken App",
                    slug: "broken-app",
                    organizationId: harness.organizationId,
                    architecture: ApplicationArchitecture.WEB,
                },
            });

            const list = await harness.request().applications.list();

            const ids = list.map((a) => a.id);
            expect(ids).toContain(web.id);
            expect(ids).toContain(ios.id);
            expect(list).toHaveLength(2);
        });

        test("creates with correct architecture", async ({ seedResult: { web, ios } }) => {
            expect(web.architecture).toBe(ApplicationArchitecture.WEB);
            expect(ios.architecture).toBe(ApplicationArchitecture.IOS);
        });

        // Without the row every completion check reads the app as not live, permanently: nothing
        // else creates one, and no screen can advance a step that does not exist.
        test("seeds an onboarding row so the app can be taken live", async ({ harness, seedResult: { web, ios } }) => {
            const rows = await harness.db.onboardingState.findMany({
                where: { applicationId: { in: [web.id, ios.id] } },
                select: { applicationId: true, step: true },
            });

            expect(rows).toHaveLength(2);
            expect(rows.every((row) => row.step === "github")).toBe(true);
        });

        test("throws CONFLICT on duplicate name within same organization", async ({ harness, seedResult: { web } }) => {
            await expect(
                harness.request().applications.create({
                    name: web.name,
                    architecture: ApplicationArchitecture.WEB,
                    url: "https://other.com",
                    file: "s3://bucket/other-file.png",
                }),
            ).rejects.toBeInstanceOf(TRPCError);
        });

        test("web application has correct url", async ({ seedResult: { web } }) => {
            expect(web.mainBranch?.deployment?.webDeployment?.url).toBe("https://example.com");
            expect(web.mainBranch?.deployment?.mobileDeployment).toBeNull();
        });

        test("ios application has correct packageUrl", async ({ seedResult: { ios } }) => {
            expect(ios.mainBranch?.deployment?.mobileDeployment?.packageUrl).toBe("s3://bucket/app.ipa");
            expect(ios.mainBranch?.deployment?.mobileDeployment?.photo).toBe("s3://bucket/default-photo.png");
            expect(ios.mainBranch?.deployment?.webDeployment).toBeNull();
        });

        test("updates web application url", async ({ harness, seedResult: { web } }) => {
            const updated = await harness.request().applications.updateData({
                id: web.id,
                architecture: ApplicationArchitecture.WEB,
                url: "https://updated.com",
            });
            expect(updated.mainBranch?.deployment?.webDeployment?.url).toBe("https://updated.com");
        });

        test("updates application name", async ({ harness, seedResult: { web } }) => {
            const updated = await harness.request().applications.updateData({
                id: web.id,
                architecture: ApplicationArchitecture.WEB,
                name: "Renamed App",
                url: "https://example.com",
            });
            expect(updated.name).toBe("Renamed App");
        });

        test("throws NOT_FOUND when updating a non-existent application", async ({ harness }) => {
            await expect(
                harness.request().applications.updateData({
                    id: "non-existent-id",
                    architecture: ApplicationArchitecture.WEB,
                    url: "https://example.com",
                }),
            ).rejects.toBeInstanceOf(TRPCError);
        });

        test("throws NOT_FOUND when deleting a non-existent application", async ({ harness }) => {
            await expect(harness.request().applications.delete({ id: "non-existent-id" })).rejects.toBeInstanceOf(
                TRPCError,
            );
        });

        test("delete frees the GitHub repo link so it can be re-linked to a new app", async ({
            harness,
            seedResult: { web },
        }) => {
            const repoId = 9_123_456;
            await harness.db.application.update({ where: { id: web.id }, data: { githubRepositoryId: repoId } });

            await harness.request().applications.delete({ id: web.id });

            const deleted = await harness.db.application.findUniqueOrThrow({
                where: { id: web.id },
                select: { disabled: true, githubRepositoryId: true },
            });
            expect(deleted.disabled).toBe(true);
            expect(deleted.githubRepositoryId).toBeNull();

            // The same repo must now link to another app in the org without
            // tripping the unique [organizationId, githubRepositoryId] constraint.
            const fresh = await harness.services.applications.createApplication({
                name: "Fresh App",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://fresh.example.com",
                file: "s3://bucket/default-file.png",
            });
            await expect(
                harness.db.application.update({ where: { id: fresh.id }, data: { githubRepositoryId: repoId } }),
            ).resolves.toBeDefined();
        });

        test("delete removes the application's preview and trigger config rows", async ({ harness }) => {
            const doomed = await harness.services.applications.createApplication({
                name: "Configured App",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://configured.example.com",
                file: "s3://bucket/default-file.png",
            });
            const survivor = await harness.services.applications.createApplication({
                name: "Untouched App",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://untouched.example.com",
                file: "s3://bucket/default-file.png",
            });

            await harness.db.previewkitConfig.create({ data: { applicationId: doomed.id } });
            await harness.db.applicationTriggerConfig.create({
                data: { applicationId: doomed.id, autoRunOnReadyForReview: true },
            });
            await harness.db.previewkitConfig.create({ data: { applicationId: survivor.id } });

            await harness.request().applications.delete({ id: doomed.id });

            expect(await harness.db.previewkitConfig.findUnique({ where: { applicationId: doomed.id } })).toBeNull();
            expect(
                await harness.db.applicationTriggerConfig.findUnique({ where: { applicationId: doomed.id } }),
            ).toBeNull();
            expect(
                await harness.db.previewkitConfig.findUnique({ where: { applicationId: survivor.id } }),
            ).not.toBeNull();
        });

        /**
         * Deleting an application must take its sealed secret values with it. The
         * delete is a SOFT one - the row is disabled and renamed, never removed - so
         * `PreviewkitSecret`'s cascade never fires and this is the only thing standing
         * between a customer deleting an app and their credentials living on. It is
         * also invisible in ordinary use, which is why it is pinned here.
         */
        test("delete takes the application's preview secrets, and only that application's", async ({ harness }) => {
            const provider = new FakeKeyProvider();
            await mintSecretKey({ db: harness.db, provider, keyId: `key-${crypto.randomUUID()}` });
            const values = new SecretValues(harness.db, new SecretKeys(harness.db, provider));

            const doomed = await harness.services.applications.createApplication({
                name: "App With Secrets",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://secrets.example.com",
                file: "s3://bucket/default-file.png",
            });
            const survivor = await harness.services.applications.createApplication({
                name: "Other App With Secrets",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://other-secrets.example.com",
                file: "s3://bucket/default-file.png",
            });
            for (const applicationId of [doomed.id, survivor.id]) {
                // A secret binds its app row, so "web" has to be in the topology first.
                await harness.seedTopology(applicationId, ["web"]);
                await values.put({ applicationId, appName: "web" }, [{ key: "STRIPE_SECRET_KEY", value: "sk_test_x" }]);
            }

            await harness.request().applications.delete({ id: doomed.id });

            const heldBy = async (applicationId: string) =>
                await harness.db.previewkitSecret.count({ where: { app: { config: { applicationId } } } });
            expect(await heldBy(doomed.id)).toBe(0);
            expect(await heldBy(survivor.id)).toBe(1);
            // The application row itself survives - a soft delete, so nothing cascaded.
            expect(
                await harness.db.application.findUniqueOrThrow({
                    where: { id: doomed.id },
                    select: { disabled: true },
                }),
            ).toEqual({ disabled: true });
        });
    },
});
