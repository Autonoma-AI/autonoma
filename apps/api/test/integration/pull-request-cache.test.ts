import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { PullRequestCacheService } from "../../src/github/pull-request-cache.service";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "PullRequestCacheService.revalidate",
    seed: async ({ harness }) => {
        const fakeClient = harness.githubApp.defaultClient;

        fakeClient.addRepository({
            id: 7001,
            name: "agree-web",
            fullName: "org/agree-web",
            defaultBranch: "main",
            commits: ["base-sha"],
        });

        const app = await harness.services.applications.createApplication({
            name: "agree-web",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/file.png",
        });
        await harness.db.application.update({
            where: { id: app.id },
            data: { githubRepositoryId: 7001 },
        });
        // Distinct installation id per suite: the integration suites share one DB with no
        // per-suite truncation, and installation_id is globally unique, so reusing the same id
        // across suites collides on the shared table when files run concurrently.
        await harness.services.github.handleInstallation(
            22222,
            harness.organizationId,
            "test-org",
            999,
            "Organization",
        );

        const prCache = new PullRequestCacheService(harness.db, harness.services.github);
        return { app, fakeClient, prCache };
    },
    cases: (test) => {
        // Regression: a PR merged on GitHub leaves the open-PR list. Revalidation used to
        // blindly stamp every such row "closed" (GitHub reports state="closed" for merged
        // PRs too), so merged PRs showed up under the Closed tab. The fix resolves each
        // transitioned row's true terminal state via an individual fetch.
        test("resolves merged vs closed for PRs that left the open list instead of marking them all closed", async ({
            harness,
            seedResult: { app, fakeClient, prCache },
        }) => {
            const prs = [
                { number: 101, state: "open" as const },
                { number: 102, state: "merged" as const },
                { number: 103, state: "closed" as const },
            ];

            for (const pr of prs) {
                fakeClient.addPullRequest("org/agree-web", {
                    number: pr.number,
                    title: `PR #${pr.number}`,
                    headRef: `feature/branch-${pr.number}`,
                    baseSha: "base-sha",
                    commits: [`head-sha-${pr.number}`],
                    state: pr.state,
                });

                // All three are stale in our cache and still marked "open" (the pre-fix bad
                // state), with no prCachedAt so the freshness gate lets revalidation run.
                const branch = await harness.db.branch.create({
                    data: {
                        name: `feature/branch-${pr.number}`,
                        applicationId: app.id,
                        organizationId: harness.organizationId,
                    },
                });
                await harness.db.featureBranchInfo.create({
                    data: { branchId: branch.id, applicationId: app.id, prNumber: pr.number, prState: "open" },
                });
            }

            await prCache.revalidate(app.id, harness.organizationId);

            const rows = await harness.db.featureBranchInfo.findMany({
                where: { applicationId: app.id },
                select: { prNumber: true, prState: true },
            });
            const stateByNumber = new Map(rows.map((r) => [r.prNumber, r.prState]));

            expect(stateByNumber.get(101)).toBe("open");
            expect(stateByNumber.get(102)).toBe("merged");
            expect(stateByNumber.get(103)).toBe("closed");
        });
    },
});
