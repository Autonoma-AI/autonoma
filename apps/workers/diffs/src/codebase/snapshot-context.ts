import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, type OnboardingStep } from "@autonoma/db";
import { Codebase } from "@autonoma/diffs";
import { type GitHubApp, type GitHubInstallationClient } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";
import { createGithubApp } from "../create-services";

let githubAppSingleton: GitHubApp | undefined;

function getGithubApp(): GitHubApp {
    if (githubAppSingleton == null) {
        githubAppSingleton = createGithubApp();
    }
    return githubAppSingleton;
}

/** The snapshot metadata the analysis activities need (resolved without cloning). */
export interface SnapshotMeta {
    baseSha: string;
    headSha: string;
    /** When this PR snapshot was created - the cutoff for independent (pre-PR) test selection. */
    createdAt: Date;
    repoFullName: string;
    organizationId: string;
    applicationId: string;
    appSlug: string;
    clientName: string;
    branchId: string;
    githubRepositoryId: number;
    /** The application's onboarding step - gates whether we may post PR comments (only once `completed`). */
    onboardingStep: OnboardingStep | undefined;
    githubClient: GitHubInstallationClient;
}

/** The cloned codebase plus the snapshot metadata. */
export interface SnapshotContext extends SnapshotMeta {
    codebase: Codebase;
}

/** Resolve a snapshot's repo + GitHub client + identifiers WITHOUT cloning. */
export async function resolveSnapshotMeta(snapshotId: string): Promise<SnapshotMeta> {
    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: {
            headSha: true,
            baseSha: true,
            createdAt: true,
            branch: {
                select: {
                    id: true,
                    application: {
                        select: {
                            id: true,
                            slug: true,
                            name: true,
                            organizationId: true,
                            githubRepositoryId: true,
                            onboardingState: { select: { step: true } },
                        },
                    },
                },
            },
        },
    });
    const application = snapshot.branch.application;
    if (snapshot.headSha == null) throw new Error(`Snapshot ${snapshotId} has no headSha`);
    if (application.githubRepositoryId == null)
        throw new Error(`Application ${application.id} has no githubRepositoryId`);
    if (snapshot.baseSha == null) throw new Error(`Snapshot ${snapshotId} has no baseSha`);

    const installation = await db.gitHubInstallation.findUniqueOrThrow({
        where: { organizationId: application.organizationId },
    });
    const githubClient = await getGithubApp().getInstallationClient(installation.installationId);
    const repo = await githubClient.getRepository(application.githubRepositoryId);

    return {
        baseSha: snapshot.baseSha,
        headSha: snapshot.headSha,
        createdAt: snapshot.createdAt,
        repoFullName: repo.fullName,
        organizationId: application.organizationId,
        applicationId: application.id,
        appSlug: application.slug,
        clientName: application.name,
        branchId: snapshot.branch.id,
        githubRepositoryId: application.githubRepositoryId,
        onboardingStep: application.onboardingState?.step,
        githubClient,
    };
}

/**
 * Resolve + clone a snapshot's repo for the duration of one activity, exposing the SHAs and repo metadata
 * (which the diffs worker's withCodebaseForSnapshot keeps private), then dispose the clone on exit.
 *
 * The clone lands in a UNIQUE directory per invocation (`mkdtemp`), never a deterministic path, so several
 * activities can run per pod without colliding on the filesystem (`Codebase.clone` rimrafs its target first).
 * `targetDirSeed` only labels the temp dir for readability; uniqueness comes from `mkdtemp`.
 */
export async function withSnapshotContext<T>(
    snapshotId: string,
    targetDirSeed: string,
    body: (context: SnapshotContext) => Promise<T>,
): Promise<T> {
    const meta = await resolveSnapshotMeta(snapshotId);
    const cloneDir = await mkdtemp(join(tmpdir(), `codebase-${targetDirSeed}-`));

    try {
        const codebase = await Codebase.clone(meta.githubClient, cloneDir, {
            repoName: meta.repoFullName,
            commitSha: meta.headSha,
            baseSha: meta.baseSha,
        });
        try {
            return await body({ ...meta, codebase });
        } finally {
            await codebase.dispose();
        }
    } catch (error) {
        // Unconditional cleanup: if Codebase.clone throws, `dispose()` never runs and the empty mkdtemp dir
        // would leak. `rm` with force is a no-op on the success/body-throw path (dispose already removed it).
        await rm(cloneDir, { recursive: true, force: true }).catch((rmError) => {
            rootLogger.warn("Failed to remove analysis clone dir after failure", {
                extra: { cloneDir, rmError },
            });
        });
        throw error;
    }
}
