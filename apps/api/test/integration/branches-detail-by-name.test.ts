import { ApplicationArchitecture, SnapshotStatus, TriggerSource } from "@autonoma/db";
import { expect } from "vitest";
import { upsertPrBranch } from "../../src/routes/branches/upsert-pr-branch";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

// Branch names are not unique per application: PR branches store the PR head ref as their name, so a
// release PR whose head ref equals the main branch name creates a snapshot-less homonym. detailByName
// must resolve deterministically instead of returning an arbitrary row.
apiTestSuite({
    name: "branches detail by name",
    cases: (test) => {
        test("resolves the main branch when a PR branch shares its name", async ({ harness }) => {
            const { applicationId, mainBranch } = await createAppWithMainBranch(harness);

            const prBranch = await upsertPrBranch({
                db: harness.db,
                applicationId,
                organizationId: harness.organizationId,
                prNumber: 1928,
                name: mainBranch.name,
            });
            expect(prBranch.id).not.toBe(mainBranch.id);

            // Touch the main branch after the homonym exists, as snapshot activity constantly does in
            // production: the update moves its heap tuple past the homonym's, so an unordered findFirst
            // scan returns the snapshot-less homonym first. This is the ordering that broke centinel-app.
            await harness.db.branch.update({
                where: { id: mainBranch.id },
                data: { name: mainBranch.name },
            });

            const detail = await harness
                .request()
                .branches.detailByName({ applicationId, branchName: mainBranch.name });

            expect(detail.id).toBe(mainBranch.id);
            expect(detail.activeSnapshot.id).toBe(mainBranch.activeSnapshotId);
        });

        test("prefers the homonymous PR branch with an active snapshot", async ({ harness }) => {
            const { applicationId } = await createAppWithMainBranch(harness);

            const withSnapshot = await upsertPrBranch({
                db: harness.db,
                applicationId,
                organizationId: harness.organizationId,
                prNumber: 101,
                name: "feature/checkout",
            });
            const withoutSnapshot = await upsertPrBranch({
                db: harness.db,
                applicationId,
                organizationId: harness.organizationId,
                prNumber: 102,
                name: "feature/checkout",
            });
            const snapshotId = await attachActiveSnapshot(harness, withSnapshot.id);
            // Bump the empty branch's updatedAt so recency alone would pick the wrong row.
            await harness.db.branch.update({
                where: { id: withoutSnapshot.id },
                data: { name: "feature/checkout" },
            });

            const detail = await harness
                .request()
                .branches.detailByName({ applicationId, branchName: "feature/checkout" });

            expect(detail.id).toBe(withSnapshot.id);
            expect(detail.activeSnapshot.id).toBe(snapshotId);
        });

        test("throws when every branch with the name lacks an active snapshot", async ({ harness }) => {
            const { applicationId } = await createAppWithMainBranch(harness);

            await upsertPrBranch({
                db: harness.db,
                applicationId,
                organizationId: harness.organizationId,
                prNumber: 103,
                name: "feature/empty",
            });

            await expect(
                harness.request().branches.detailByName({ applicationId, branchName: "feature/empty" }),
            ).rejects.toThrow("Branch has no active snapshot");
        });

        test("throws not found for a name no branch has", async ({ harness }) => {
            const { applicationId } = await createAppWithMainBranch(harness);

            await expect(
                harness.request().branches.detailByName({ applicationId, branchName: "no-such-branch" }),
            ).rejects.toThrow("Branch not found");
        });
    },
});

async function createAppWithMainBranch(harness: APITestHarness) {
    const application = await harness.services.applications.createApplication({
        name: `Detail By Name ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/default-file.png",
    });
    const app = await harness.db.application.findUniqueOrThrow({
        where: { id: application.id },
        select: {
            id: true,
            mainBranch: { select: { id: true, name: true, activeSnapshotId: true } },
        },
    });
    if (app.mainBranch == null) throw new Error("Expected createApplication to set a main branch");
    return { applicationId: app.id, mainBranch: app.mainBranch };
}

async function attachActiveSnapshot(harness: APITestHarness, branchId: string) {
    const snapshot = await harness.db.branchSnapshot.create({
        data: { branchId, source: TriggerSource.MANUAL, status: SnapshotStatus.active },
        select: { id: true },
    });
    await harness.db.branch.update({ where: { id: branchId }, data: { activeSnapshotId: snapshot.id } });
    return snapshot.id;
}
