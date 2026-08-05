import { logger } from "@autonoma/logger";
import { expect } from "vitest";
import { recordBranchDeployment } from "../src/queries/record-branch-deployment";
import { startAnalysisRun } from "../src/queries/start-analysis-run";
import { testUpdateSuite } from "./harness";

testUpdateSuite({
    name: "startAnalysisRun / recordBranchDeployment",
    cases: (test) => {
        test("opens a run as a pending snapshot plus its AnalysisJob, and nothing else", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 7 });
            const snapshotId = await startAnalysisRun({
                db: harness.db,
                logger,
                branchId,
                headSha: "head-1",
                baseSha: "base-1",
            });

            // Scoped to the branch's own owner, which is why no caller passes an organization in.
            const job = await harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId } });
            expect(job.organizationId).toBe(organizationId);
            expect(await harness.db.diffsJob.findUnique({ where: { snapshotId } })).toBeNull();
            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
            expect(snapshot.investigationSnapshotId).toBeNull();
        });

        // A branch holds at most one pending snapshot, so a second push has to take the branch over rather than be
        // refused. Cancelling the displaced run's workflow is Temporal's job (runs are keyed on the branch with a
        // terminate-existing policy); settling its database state is this function's, and termination runs no
        // workflow code, so without it the old run would dangle in `running` forever.
        test("supersedes the run already in flight on the branch", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 11 });
            const open = (headSha: string, baseSha: string) =>
                startAnalysisRun({ db: harness.db, logger, branchId, headSha, baseSha });

            const staleSnapshotId = await open("head-old", "base-old");
            const freshSnapshotId = await open("head-new", "base-new");

            expect(freshSnapshotId).not.toBe(staleSnapshotId);

            const stale = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: staleSnapshotId } });
            // A superseded run settles its snapshot `cancelled`: it never reached a verdict, so it is closed out
            // rather than recorded as one.
            expect(stale.status).toBe("cancelled");
            const staleJob = await harness.db.analysisJob.findUniqueOrThrow({ where: { snapshotId: staleSnapshotId } });
            expect(staleJob.status).toBe("failed");
            expect(staleJob.failureReason).toContain("Superseded");
            expect(staleJob.completedAt).not.toBeNull();

            const fresh = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: freshSnapshotId } });
            expect(fresh.status).toBe("processing");
        });

        // The ordering the previewkit inversion depends on: the run the source-only analysis stage works on is
        // opened before any preview exists, and the URL-bearing deployment is recorded only once one does.
        test("opens a run with no deployment, then records one later", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 21 });

            const snapshotId = await startAnalysisRun({
                db: harness.db,
                logger,
                branchId,
                headSha: "head-1",
                baseSha: "base-1",
            });

            expect((await harness.db.branch.findUniqueOrThrow({ where: { id: branchId } })).deploymentId).toBeNull();
            expect(await harness.db.branchDeployment.count({ where: { branchId } })).toBe(0);

            const deploymentId = await recordBranchDeployment({
                db: harness.db,
                logger,
                branchId,
                organizationId,
                url: "https://preview.example.com",
                webhookUrl: "https://preview.example.com/api/autonoma",
            });

            expect((await harness.db.branch.findUniqueOrThrow({ where: { id: branchId } })).deploymentId).toBe(
                deploymentId,
            );
            const deployment = await harness.db.branchDeployment.findUniqueOrThrow({
                where: { id: deploymentId },
                include: { webDeployment: true },
            });
            expect(deployment.webDeployment?.url).toBe("https://preview.example.com");
            // The run the analysis stage already worked on is the one the deployment now serves.
            expect(await harness.db.branchSnapshot.count({ where: { branchId } })).toBe(1);
            expect(await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: snapshotId } })).toBeDefined();
        });

        // Without the bypass header every scenario up/down against a sleeping preview is answered by the
        // Gatekeeper rather than the app.
        test("carries the previewkit bypass token when the URL is a preview app", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 31 });
            const url = "https://web-pr-31.preview.example.com";

            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-widgets-pr-31",
                    repoFullName: "acme/widgets",
                    prNumber: 31,
                    headSha: "head-1",
                    headRef: "feature/checkout",
                    organizationId,
                    status: "ready",
                    bypassToken: "bypass-secret",
                },
            });
            await harness.db.previewkitAppInstance.create({
                data: { environmentId: environment.id, appName: "web", status: "ready", url, port: 3000 },
            });

            const deploymentId = await recordBranchDeployment({
                db: harness.db,
                logger,
                branchId,
                organizationId,
                url,
                webhookUrl: `${url}/api/autonoma`,
            });

            const deployment = await harness.db.branchDeployment.findUniqueOrThrow({ where: { id: deploymentId } });
            expect(deployment.webhookHeaders).toEqual({ "x-previewkit-bypass": "bypass-secret" });
        });

        test("leaves webhook headers untouched for a URL that is not a preview app", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 41 });

            const deploymentId = await recordBranchDeployment({
                db: harness.db,
                logger,
                branchId,
                organizationId,
                url: "https://customer-deployed.vercel.app",
                webhookHeaders: { authorization: "Bearer token" },
            });

            const deployment = await harness.db.branchDeployment.findUniqueOrThrow({ where: { id: deploymentId } });
            expect(deployment.webhookHeaders).toEqual({ authorization: "Bearer token" });
        });
    },
});
