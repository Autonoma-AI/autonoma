import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { OnboardingTestHarness } from "../onboarding/onboarding-harness";

/**
 * Deliberately the same repo name previewkit-write.test.ts seeds. Each test file runs in its own
 * worker against the shared database, so a per-process counter in the harness would hand both files
 * PR 1 and whichever ran second would fail on the unique namespace - this suite exists to keep that
 * allocation coming from the database.
 */
const SHARED_REPO_FULL_NAME = "acme/web";

integrationTestSuite({
    name: "Onboarding harness preview seeding",
    createHarness: () => OnboardingTestHarness.create(),
    seed: async (harness) => ({ orgId: await harness.createOrg() }),
    cases: (test) => {
        test("seeds a distinct namespace, PR number and repository id per call", async ({
            harness,
            seedResult: { orgId },
        }) => {
            // Sequential: createApp names apps after the current millisecond, so two at once collide.
            const firstAppId = await harness.createApp(orgId);
            const secondAppId = await harness.createApp(orgId);
            await harness.linkPreviewRepo(firstAppId, orgId, SHARED_REPO_FULL_NAME);
            await harness.linkPreviewRepo(secondAppId, orgId, SHARED_REPO_FULL_NAME);

            const apps = await harness.db.application.findMany({
                where: { id: { in: [firstAppId, secondAppId] } },
                select: { githubRepositoryId: true },
            });
            const environments = await harness.db.previewkitEnvironment.findMany({
                where: { githubRepositoryId: { in: apps.map((app) => app.githubRepositoryId ?? 0) } },
                select: { namespace: true, prNumber: true, githubRepositoryId: true },
            });

            const repositoryIds = apps.map((app) => app.githubRepositoryId);
            expect(new Set(repositoryIds).size).toBe(2);
            expect(environments).toHaveLength(2);
            expect(new Set(environments.map((environment) => environment.namespace)).size).toBe(2);
            expect(new Set(environments.map((environment) => environment.prNumber)).size).toBe(2);
            expect(new Set(environments.map((environment) => environment.githubRepositoryId))).toEqual(
                new Set(repositoryIds),
            );
        });
    },
});
