import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { recordBranchDeployment } from "../src/record-branch-deployment";
import { ScenarioTestHarness } from "./scenario-harness";

integrationTestSuite({
    name: "recordBranchDeployment",
    createHarness: () => ScenarioTestHarness.create(),
    seed: async (harness) => {
        const organizationId = await harness.createOrg();
        const { appId } = await harness.createApp(organizationId);
        return { organizationId, applicationId: appId };
    },
    cases: (test) => {
        test("records a deployment and points the branch at it", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId, 21);

            expect((await harness.db.branch.findUniqueOrThrow({ where: { id: branchId } })).deploymentId).toBeNull();
            expect(await harness.db.branchDeployment.count({ where: { branchId } })).toBe(0);

            const deploymentId = await recordBranchDeployment({
                db: harness.db,
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
        });

        // Without the bypass header every scenario up/down against a sleeping preview is answered by the
        // Gatekeeper rather than the app.
        test("carries the previewkit bypass token when the URL is a preview app", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId, 31);
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
                branchId,
                organizationId,
                url,
                webhookUrl: `${url}/api/autonoma`,
            });

            const deployment = await harness.db.branchDeployment.findUniqueOrThrow({ where: { id: deploymentId } });
            expect(deployment.webhookHeaders).toEqual({ "x-previewkit-bypass": "bypass-secret" });
        });

        test("leaves webhook headers untouched for a URL that is not a preview app", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId, 41);

            const deploymentId = await recordBranchDeployment({
                db: harness.db,
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
