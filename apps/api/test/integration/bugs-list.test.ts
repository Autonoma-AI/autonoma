import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

async function seedFixture(harness: APITestHarness) {
    const application = await harness.services.applications.createApplication({
        name: "Main Scoped App",
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/default-file.png",
    });

    if (application.mainBranchId == null) throw new Error("expected application to have a main branch");
    const mainBranchId = application.mainBranchId;

    const featureBranch = await harness.db.branch.create({
        data: {
            name: "feature/x",
            applicationId: application.id,
            organizationId: harness.organizationId,
        },
    });

    const mainOpenBug = await harness.db.bug.create({
        data: {
            title: "Main open bug",
            description: "An open bug on the main branch.",
            severity: "critical",
            branchId: mainBranchId,
            applicationId: application.id,
            organizationId: harness.organizationId,
        },
    });

    const mainResolvedBug = await harness.db.bug.create({
        data: {
            title: "Main resolved bug",
            description: "A resolved bug on the main branch.",
            severity: "high",
            status: "resolved",
            resolvedAt: new Date(),
            branchId: mainBranchId,
            applicationId: application.id,
            organizationId: harness.organizationId,
        },
    });

    const featureBug = await harness.db.bug.create({
        data: {
            title: "Feature branch bug",
            description: "A bug only on a PR branch.",
            severity: "critical",
            branchId: featureBranch.id,
            applicationId: application.id,
            organizationId: harness.organizationId,
        },
    });

    const abandonedBug = await harness.db.bug.create({
        data: {
            title: "Abandoned bug",
            description: "A pre-migration bug with a null branch.",
            severity: "critical",
            applicationId: application.id,
            organizationId: harness.organizationId,
        },
    });

    // A second application, so the org-wide listing has more than one main branch to union.
    const otherApplication = await harness.services.applications.createApplication({
        name: "Other Main Scoped App",
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://other.example.com",
        file: "s3://bucket/other-default-file.png",
    });

    if (otherApplication.mainBranchId == null) throw new Error("expected other application to have a main branch");

    const otherAppMainBug = await harness.db.bug.create({
        data: {
            title: "Other app main bug",
            description: "An open bug on the other app's main branch.",
            severity: "high",
            branchId: otherApplication.mainBranchId,
            applicationId: otherApplication.id,
            organizationId: harness.organizationId,
        },
    });

    return {
        application,
        otherApplication,
        mainOpenBug,
        mainResolvedBug,
        featureBug,
        abandonedBug,
        otherAppMainBug,
    };
}

apiTestSuite({
    name: "bugs.list main-branch scoping",
    seed: async ({ harness }) => seedFixture(harness),
    cases: (test) => {
        test("list returns only the application's main-branch bugs", async ({ harness, seedResult }) => {
            const bugs = await harness.request().bugs.list({ applicationId: seedResult.application.id });
            const ids = bugs.map((bug) => bug.id);

            expect(ids).toEqual(expect.arrayContaining([seedResult.mainOpenBug.id, seedResult.mainResolvedBug.id]));
            expect(ids).not.toContain(seedResult.featureBug.id);
            expect(ids).not.toContain(seedResult.abandonedBug.id);
            expect(ids).not.toContain(seedResult.otherAppMainBug.id);
        });

        test("list honors the status filter within the main branch", async ({ harness, seedResult }) => {
            const bugs = await harness.request().bugs.list({
                applicationId: seedResult.application.id,
                status: "open",
            });

            expect(bugs.map((bug) => bug.id)).toEqual([seedResult.mainOpenBug.id]);
        });

        test("org-wide list unions every application's main-branch bugs", async ({ harness, seedResult }) => {
            const bugs = await harness.request().bugs.list();
            const ids = bugs.map((bug) => bug.id);

            expect(ids).toEqual(
                expect.arrayContaining([
                    seedResult.mainOpenBug.id,
                    seedResult.mainResolvedBug.id,
                    seedResult.otherAppMainBug.id,
                ]),
            );
            expect(ids).not.toContain(seedResult.featureBug.id);
            expect(ids).not.toContain(seedResult.abandonedBug.id);
        });
    },
});
