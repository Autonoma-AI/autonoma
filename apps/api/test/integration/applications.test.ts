import { ApplicationArchitecture } from "@autonoma/db";
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
    },
});
