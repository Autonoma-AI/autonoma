import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { env } from "../../src/env";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

apiTestSuite({
    name: "deployments.redeployApp",
    cases: (test) => {
        test("triggers a redeploy for an app in the application's preview environment", async ({ harness }) => {
            const fixture = await createRedeployFixture(harness, 1_201, 51_201);
            harness.triggerWorkflow.mockClear();

            const previewkitWasEnabled = env.PREVIEWKIT_ENABLED;
            env.PREVIEWKIT_ENABLED = true;
            try {
                await harness.request().deployments.redeployApp({
                    applicationId: fixture.applicationId,
                    environmentId: fixture.environmentId,
                    app: "web",
                    mode: "rebuild",
                });
            } finally {
                env.PREVIEWKIT_ENABLED = previewkitWasEnabled;
            }

            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                event: {
                    action: "synchronize",
                    prNumber: fixture.prNumber,
                    repoFullName: fixture.repoFullName,
                    organizationId: harness.organizationId,
                    githubRepositoryId: fixture.githubRepositoryId,
                    headSha: "redeploy-head",
                    headRef: "feature/redeploy",
                    baseSha: "",
                    baseRef: "",
                    cloneUrl: "",
                },
                namespace: fixture.namespace,
                appName: "web",
                mode: "rebuild",
            });
        });

        test("rejects an environment linked to another application repository", async ({ harness }) => {
            const fixture = await createRedeployFixture(harness, 1_202, 51_202, 61_202);
            harness.triggerWorkflow.mockClear();

            await expect(
                harness.request().deployments.redeployApp({
                    applicationId: fixture.applicationId,
                    environmentId: fixture.environmentId,
                    app: "web",
                    mode: "restart",
                }),
            ).rejects.toThrow("Preview environment not found");
            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });
    },
});

async function createRedeployFixture(
    harness: APITestHarness,
    prNumber: number,
    applicationRepositoryId: number,
    environmentRepositoryId: number = applicationRepositoryId,
) {
    const application = await harness.db.application.create({
        data: {
            name: `Redeploy App ${prNumber}`,
            slug: `redeploy-app-${prNumber}`,
            architecture: ApplicationArchitecture.WEB,
            organizationId: harness.organizationId,
            githubRepositoryId: applicationRepositoryId,
        },
    });
    const repoFullName = `Autonoma-AI/redeploy-${prNumber}`;
    const namespace = `preview-redeploy-pr-${prNumber}`;
    const environment = await harness.db.previewkitEnvironment.create({
        data: {
            namespace,
            repoFullName,
            prNumber,
            headSha: "redeploy-head",
            headRef: "feature/redeploy",
            githubRepositoryId: environmentRepositoryId,
            organizationId: harness.organizationId,
            status: "ready",
            appInstances: { create: [{ appName: "web", status: "ready", port: 3000 }] },
        },
    });

    return {
        applicationId: application.id,
        environmentId: environment.id,
        githubRepositoryId: environmentRepositoryId,
        namespace,
        prNumber,
        repoFullName,
    };
}
