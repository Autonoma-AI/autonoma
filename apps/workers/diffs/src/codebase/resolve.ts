import { db } from "@autonoma/db";
import { Codebase } from "@autonoma/diffs";
import { type GitHubApp, type GitHubInstallationClient, OctokitGitHubApp } from "@autonoma/github";
import { env } from "../env";

let githubAppSingleton: GitHubApp | undefined;

function getGithubApp(): GitHubApp {
    if (githubAppSingleton == null) {
        githubAppSingleton = new OctokitGitHubApp({
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_APP_PRIVATE_KEY,
            webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
            appSlug: env.GITHUB_APP_SLUG,
        });
    }
    return githubAppSingleton;
}

interface SnapshotLocation {
    organizationId: string;
    githubRepositoryId: number | null;
    headSha: string | null;
}

interface ResolvedClone {
    githubClient: GitHubInstallationClient;
    repoName: string;
    commitSha: string;
}

async function resolveClone(location: SnapshotLocation, label: string): Promise<ResolvedClone> {
    if (location.headSha == null) throw new Error(`${label} snapshot has no headSha`);
    if (location.githubRepositoryId == null) {
        throw new Error(`${label} application has no githubRepositoryId`);
    }
    const installation = await db.gitHubInstallation.findUniqueOrThrow({
        where: { organizationId: location.organizationId },
    });
    const githubClient = await getGithubApp().getInstallationClient(installation.installationId);
    const repo = await githubClient.getRepository(location.githubRepositoryId);
    return { githubClient, repoName: repo.fullName, commitSha: location.headSha };
}

interface WithCodebaseHandlers<T> {
    body: (codebase: Codebase) => Promise<T>;
    targetDirSeed: string;
}

/**
 * Activity-scoped helper: clones a codebase for the duration of a single
 * Temporal activity and disposes it on exit. Each activity invocation gets a
 * fresh clone, since the activity boundary is the right disposal point.
 *
 * Throws if the snapshot has no GitHub repo / head SHA, the org has no
 * installation, or the clone itself fails.
 */
export async function withCodebaseForGeneration<T>(
    generationId: string,
    handlers: WithCodebaseHandlers<T>,
): Promise<T> {
    const generation = await db.testGeneration.findUniqueOrThrow({
        where: { id: generationId },
        select: {
            snapshot: {
                select: {
                    headSha: true,
                    branch: {
                        select: {
                            application: {
                                select: { organizationId: true, githubRepositoryId: true },
                            },
                        },
                    },
                },
            },
        },
    });
    const resolved = await resolveClone(
        {
            organizationId: generation.snapshot.branch.application.organizationId,
            githubRepositoryId: generation.snapshot.branch.application.githubRepositoryId,
            headSha: generation.snapshot.headSha,
        },
        `Generation ${generationId}`,
    );
    const codebase = await Codebase.clone(resolved.githubClient, `/tmp/codebase/${handlers.targetDirSeed}`, {
        repoName: resolved.repoName,
        commitSha: resolved.commitSha,
    });
    try {
        return await handlers.body(codebase);
    } finally {
        await codebase.dispose();
    }
}

export async function withCodebaseForSnapshot<T>(snapshotId: string, handlers: WithCodebaseHandlers<T>): Promise<T> {
    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: {
            headSha: true,
            branch: {
                select: {
                    application: { select: { organizationId: true, githubRepositoryId: true } },
                },
            },
        },
    });
    const resolved = await resolveClone(
        {
            organizationId: snapshot.branch.application.organizationId,
            githubRepositoryId: snapshot.branch.application.githubRepositoryId,
            headSha: snapshot.headSha,
        },
        `Snapshot ${snapshotId}`,
    );
    const codebase = await Codebase.clone(resolved.githubClient, `/tmp/codebase/${handlers.targetDirSeed}`, {
        repoName: resolved.repoName,
        commitSha: resolved.commitSha,
    });
    try {
        return await handlers.body(codebase);
    } finally {
        await codebase.dispose();
    }
}

export async function withCodebaseForRun<T>(runId: string, handlers: WithCodebaseHandlers<T>): Promise<T> {
    const run = await db.run.findUniqueOrThrow({
        where: { id: runId },
        select: {
            assignment: {
                select: {
                    snapshot: {
                        select: {
                            headSha: true,
                            branch: {
                                select: {
                                    application: {
                                        select: { organizationId: true, githubRepositoryId: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    const resolved = await resolveClone(
        {
            organizationId: run.assignment.snapshot.branch.application.organizationId,
            githubRepositoryId: run.assignment.snapshot.branch.application.githubRepositoryId,
            headSha: run.assignment.snapshot.headSha,
        },
        `Run ${runId}`,
    );
    const codebase = await Codebase.clone(resolved.githubClient, `/tmp/codebase/${handlers.targetDirSeed}`, {
        repoName: resolved.repoName,
        commitSha: resolved.commitSha,
    });
    try {
        return await handlers.body(codebase);
    } finally {
        await codebase.dispose();
    }
}
