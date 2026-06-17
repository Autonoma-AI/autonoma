import { db } from "@autonoma/db";
import { type GitHubApp, parseRepoFullName } from "@autonoma/github";
import type { CodebaseCoords } from "../framework/codebase-cache";

/**
 * Resolve a snapshot's git coordinates from the database.
 *
 * Reads the snapshot's base/head SHAs and the application's GitHub repository,
 * then maps the repo to an `owner/repo` pair plus the installation id used to
 * mint a clone token. Throws when any of those fields are missing - capture
 * refuses to write a case it cannot rehydrate later.
 *
 * Shared by every `capture:*` command (analysis, generation review, replay
 * review, healing) so every frozen input agrees on how a snapshot maps to a
 * clone. Healing capture derives the snapshotId from the iteration first; the
 * other commands pass it directly.
 */
export async function resolveSnapshotCoords(snapshotId: string, githubApp: GitHubApp): Promise<CodebaseCoords> {
    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: {
            headSha: true,
            baseSha: true,
            branch: {
                select: {
                    application: { select: { organizationId: true, githubRepositoryId: true } },
                },
            },
        },
    });

    const { headSha, baseSha } = snapshot;
    const { organizationId, githubRepositoryId } = snapshot.branch.application;

    if (headSha == null) throw new Error(`Snapshot ${snapshotId} has no headSha`);
    if (baseSha == null) throw new Error(`Snapshot ${snapshotId} has no baseSha`);
    if (githubRepositoryId == null) {
        throw new Error(`Application for snapshot ${snapshotId} has no githubRepositoryId`);
    }

    const installation = await db.gitHubInstallation.findUniqueOrThrow({ where: { organizationId } });
    const client = await githubApp.getInstallationClient(installation.installationId);
    const repo = await client.getRepository(githubRepositoryId);
    const { owner, repo: repoName } = parseRepoFullName(repo.fullName);

    return { owner, repo: repoName, installationId: installation.installationId, baseSha, headSha };
}
