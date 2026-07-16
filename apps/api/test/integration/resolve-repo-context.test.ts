import { randomBytes } from "node:crypto";
import { ApplicationArchitecture } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { expect } from "vitest";
import type { ListedRepository } from "../../src/github/github-installation.service";
import { resolveRepoContext } from "../../src/mcp/resolve-repo-context";
import { apiTestSuite } from "../api-test";

/** A GitHub App installation repo joined with its (optionally) linked Autonoma application. */
function listed(id: number, fullName: string, applicationId?: string): ListedRepository {
    return {
        id,
        name: fullName.split("/")[1] ?? fullName,
        fullName,
        defaultBranch: "main",
        private: true,
        applicationId,
        applicationName: applicationId != null ? "app" : undefined,
    };
}

/** A fake installation lister returning canned repos per org (and [] for any org not seeded). */
function fakeLister(reposByOrg: Record<string, ListedRepository[]>) {
    const calls: string[] = [];
    const list = (organizationId: string) => {
        calls.push(organizationId);
        return Promise.resolve(reposByOrg[organizationId] ?? []);
    };
    return { list, calls };
}

apiTestSuite({
    name: "resolveRepoContext",
    seed: async ({ harness }) => {
        // The resolver's membership gate reads the `member` table, which the base harness does not populate.
        await harness.db.member.create({
            data: { userId: harness.userId, organizationId: harness.organizationId, role: "owner" },
        });
        return {};
    },
    cases: (test) => {
        test("resolves via the PreviewKit fast path without hitting the installation lister", async ({ harness }) => {
            const repoFullName = "acme/fast-path";
            const githubRepositoryId = 1001;
            const app = await harness.db.application.create({
                data: {
                    name: "Fast Path App",
                    slug: "fast-path-app",
                    architecture: ApplicationArchitecture.WEB,
                    organizationId: harness.organizationId,
                    githubRepositoryId,
                },
            });
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-fast-path-${randomBytes(4).toString("hex")}`,
                    repoFullName,
                    prNumber: 1,
                    headSha: "sha",
                    headRef: "ref",
                    githubRepositoryId,
                    organizationId: harness.organizationId,
                },
            });
            const lister = fakeLister({});

            const context = await resolveRepoContext(
                { db: harness.db, listRepositories: lister.list },
                harness.userId,
                repoFullName,
            );

            expect(context).toEqual({
                organizationId: harness.organizationId,
                applicationId: app.id,
                githubRepositoryId,
            });
            // The fast path is a pure DB lookup - it must not spend a GitHub API call.
            expect(lister.calls).toHaveLength(0);
        });

        test("resolves a diffs-only repo (no preview env) via the installation lister", async ({ harness }) => {
            const repoFullName = "acme/diffs-only";
            const githubRepositoryId = 2002;
            const app = await harness.db.application.create({
                data: {
                    name: "Diffs Only App",
                    slug: "diffs-only-app",
                    architecture: ApplicationArchitecture.WEB,
                    organizationId: harness.organizationId,
                    githubRepositoryId,
                },
            });
            const lister = fakeLister({
                [harness.organizationId]: [listed(githubRepositoryId, repoFullName, app.id)],
            });

            const context = await resolveRepoContext(
                { db: harness.db, listRepositories: lister.list },
                harness.userId,
                repoFullName,
            );

            expect(context).toEqual({
                organizationId: harness.organizationId,
                applicationId: app.id,
                githubRepositoryId,
            });
            expect(lister.calls).toContain(harness.organizationId);
        });

        test("throws NotFound when the user is a member of no organization", async ({ harness }) => {
            const lister = fakeLister({});
            await expect(
                resolveRepoContext(
                    { db: harness.db, listRepositories: lister.list },
                    `stranger-${randomBytes(4).toString("hex")}`,
                    "acme/diffs-only",
                ),
            ).rejects.toThrow(NotFoundError);
        });

        test("throws NotFound when the repo is in the installation but linked to no application", async ({
            harness,
        }) => {
            const repoFullName = "acme/unlinked";
            const lister = fakeLister({
                [harness.organizationId]: [listed(3003, repoFullName, undefined)],
            });

            await expect(
                resolveRepoContext({ db: harness.db, listRepositories: lister.list }, harness.userId, repoFullName),
            ).rejects.toThrow(NotFoundError);
        });

        test("throws a disambiguation error when the repo is linked in two of the user's orgs", async ({ harness }) => {
            const repoFullName = "acme/dup";
            const secondOrg = await harness.db.organization.create({
                data: { name: "Second Org", slug: `second-org-${randomBytes(4).toString("hex")}` },
            });
            await harness.db.member.create({
                data: { userId: harness.userId, organizationId: secondOrg.id, role: "owner" },
            });
            const appA = await harness.db.application.create({
                data: {
                    name: "Dup App A",
                    slug: "dup-app-a",
                    architecture: ApplicationArchitecture.WEB,
                    organizationId: harness.organizationId,
                    githubRepositoryId: 4004,
                },
            });
            const appB = await harness.db.application.create({
                data: {
                    name: "Dup App B",
                    slug: "dup-app-b",
                    architecture: ApplicationArchitecture.WEB,
                    organizationId: secondOrg.id,
                    githubRepositoryId: 5005,
                },
            });
            const lister = fakeLister({
                [harness.organizationId]: [listed(4004, repoFullName, appA.id)],
                [secondOrg.id]: [listed(5005, repoFullName, appB.id)],
            });

            await expect(
                resolveRepoContext({ db: harness.db, listRepositories: lister.list }, harness.userId, repoFullName),
            ).rejects.toThrow(/more than one of your organizations/);
        });
    },
});
