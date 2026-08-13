import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, type OnboardingStep } from "@autonoma/db";
import { Codebase } from "@autonoma/diffs";
import { type GitHubApp, type GitHubInstallationClient } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";
import { createGithubApp } from "../create-services";
import { resolveDependencyCheckouts } from "./resolve-dependencies";

let githubAppSingleton: GitHubApp | undefined;

function getGithubApp(): GitHubApp {
    if (githubAppSingleton == null) {
        githubAppSingleton = createGithubApp();
    }
    return githubAppSingleton;
}

/** The snapshot metadata the analysis activities need (resolved without cloning). */
export interface SnapshotMeta {
    snapshotId: string;
    baseSha: string;
    headSha: string;
    /** When this PR snapshot was created - the cutoff for independent (pre-PR) test selection. */
    createdAt: Date;
    organizationId: string;
    applicationId: string;
    appSlug: string;
    clientName: string;
    branchId: string;
    githubRepositoryId: number;
    /** The application's onboarding step - gates whether we may post PR comments (only once `completed`). */
    onboardingStep: OnboardingStep | undefined;
}

/** The authenticated repository access resolved for a snapshot's application. */
export interface GitHubAccess {
    repoFullName: string;
    githubClient: GitHubInstallationClient;
}

/** The cloned codebase plus the snapshot metadata. */
export interface SnapshotContext extends SnapshotMeta, GitHubAccess {
    codebase: Codebase;
}

/** Load only the persisted metadata a snapshot's analysis activities need. */
export async function loadSnapshotMeta(snapshotId: string): Promise<SnapshotMeta> {
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

    return {
        snapshotId,
        baseSha: snapshot.baseSha,
        headSha: snapshot.headSha,
        createdAt: snapshot.createdAt,
        organizationId: application.organizationId,
        applicationId: application.id,
        appSlug: application.slug,
        clientName: application.name,
        branchId: snapshot.branch.id,
        githubRepositoryId: application.githubRepositoryId,
        onboardingStep: application.onboardingState?.step,
    };
}

/** Build authenticated GitHub access for metadata already loaded from the database. */
export async function resolveGitHubAccess(meta: SnapshotMeta): Promise<GitHubAccess> {
    return resolveGitHubAccessFor(meta.organizationId, meta.githubRepositoryId);
}

/** Build authenticated GitHub access from an org + repo id. */
async function resolveGitHubAccessFor(organizationId: string, githubRepositoryId: number): Promise<GitHubAccess> {
    const installation = await db.gitHubInstallation.findUniqueOrThrow({ where: { organizationId } });
    const githubClient = await getGithubApp().getInstallationClient(installation.installationId);
    const repo = await githubClient.getRepository(githubRepositoryId);
    return { repoFullName: repo.fullName, githubClient };
}

interface CloneCoords {
    headSha: string;
    /** Also fetched into the clone so `git diff base..head` works. */
    baseSha?: string;
}

/**
 * Clone a snapshot's checkout into a fresh temp dir for one activity, hand it to `body`, and dispose on exit.
 * The dir is unique per invocation (`mkdtemp`), not a deterministic path, so concurrent activities on one pod
 * don't collide.
 *
 * When the snapshot pinned resolvable dependency repos, the checkout is a multi-repo **workspace** (the primary
 * plus each dependency as a named sibling, `codebase.root` = the parent); otherwise it is a flat single-repo
 * clone, exactly as before multi-repo grounding.
 */
async function withCheckout<T>(
    github: GitHubAccess,
    primary: CloneCoords,
    dependencies: Awaited<ReturnType<typeof resolveDependencyCheckouts>>,
    targetDirSeed: string,
    body: (codebase: Codebase) => Promise<T>,
): Promise<T> {
    const isMultiRepo = dependencies.dependencies.length > 0 || dependencies.unavailable.length > 0;
    const cloneDir = await mkdtemp(join(tmpdir(), `codebase-${targetDirSeed}-`));
    try {
        const codebase = isMultiRepo
            ? await Codebase.cloneWorkspace(github.githubClient, cloneDir, {
                  // The primary's manifest name is its lowercased owner/repo, matching the dependency-pin key space.
                  primary: {
                      name: github.repoFullName.toLowerCase(),
                      commitSha: primary.headSha,
                      baseSha: primary.baseSha,
                  },
                  dependencies: dependencies.dependencies,
                  unavailable: dependencies.unavailable,
              })
            : await Codebase.clone(github.githubClient, cloneDir, {
                  repoName: github.repoFullName,
                  commitSha: primary.headSha,
                  baseSha: primary.baseSha,
              });
        try {
            return await body(codebase);
        } finally {
            await codebase.dispose();
        }
    } catch (error) {
        // dispose() only runs once the clone succeeds; on a clone failure this rm is what stops the dir leaking.
        await rm(cloneDir, { recursive: true, force: true }).catch((rmError) => {
            rootLogger.warn("Failed to remove analysis clone dir after failure", {
                extra: { cloneDir, rmError },
            });
        });
        throw error;
    }
}

/**
 * Resolve + clone a snapshot's codebase for the duration of one activity, exposing the SHAs and repo metadata
 * alongside the clone, then dispose it on exit. When the snapshot pinned dependency repos, the clone is a
 * multi-repo workspace (see {@link withCheckout}).
 */
export async function withSnapshotContext<T>(
    snapshotId: string,
    targetDirSeed: string,
    body: (context: SnapshotContext) => Promise<T>,
): Promise<T> {
    const meta = await loadSnapshotMeta(snapshotId);
    const github = await resolveGitHubAccess(meta);
    const dependencies = await resolveDependencyCheckouts(db, snapshotId);
    return withCheckout(
        github,
        { headSha: meta.headSha, baseSha: meta.baseSha },
        dependencies,
        targetDirSeed,
        (codebase) => body(buildSnapshotContext(meta, github, codebase)),
    );
}

function buildSnapshotContext(meta: SnapshotMeta, github: GitHubAccess, codebase: Codebase): SnapshotContext {
    return {
        snapshotId: meta.snapshotId,
        baseSha: meta.baseSha,
        headSha: meta.headSha,
        createdAt: meta.createdAt,
        organizationId: meta.organizationId,
        applicationId: meta.applicationId,
        appSlug: meta.appSlug,
        clientName: meta.clientName,
        branchId: meta.branchId,
        githubRepositoryId: meta.githubRepositoryId,
        onboardingStep: meta.onboardingStep,
        repoFullName: github.repoFullName,
        githubClient: github.githubClient,
        codebase,
    };
}
