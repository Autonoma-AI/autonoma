import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, type OnboardingStep, type PrismaClient } from "@autonoma/db";
import { Codebase } from "@autonoma/diffs";
import { type GitHubApp, type GitHubInstallationClient, UnreachableBaseShaError } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";
import { APPLICATION_UNLINKED_FAILURE_TYPE } from "@autonoma/types";
import { ApplicationFailure } from "@temporalio/activity";
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

/** Load only the persisted metadata a snapshot's analysis activities need. `client` defaults to the shared
 * connection; an injected one lets tests seed and read through the same transaction. */
export async function loadSnapshotMeta(snapshotId: string, client: PrismaClient = db): Promise<SnapshotMeta> {
    const snapshot = await client.branchSnapshot.findUniqueOrThrow({
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
    // A null repo id on a snapshot that reached a run means the application was deleted, unlinked, or its org
    // disconnected GitHub while this run was in flight - the mutation nulls `githubRepositoryId`. This is not a
    // failure: nobody wants the result of a run against a repo we can no longer reach. It is thrown as a typed,
    // non-retryable ApplicationFailure so the settlement wrapper settles the run as `cancelled` (and the worker
    // interceptor keeps it out of the fatal stream), instead of crashing as a hard `failed` job.
    if (application.githubRepositoryId == null)
        throw ApplicationFailure.nonRetryable(
            `Application ${application.id} was unlinked or deleted mid-run (no githubRepositoryId); cancelling the analysis run`,
            APPLICATION_UNLINKED_FAILURE_TYPE,
        );
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
 * clone.
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
 * multi-repo workspace (see {@link withCheckout}). Recovers once if the recorded base SHA is unreachable on the
 * remote (see {@link cloneWithBaseRecovery}).
 */
export async function withSnapshotContext<T>(
    snapshotId: string,
    targetDirSeed: string,
    body: (context: SnapshotContext) => Promise<T>,
): Promise<T> {
    const meta = await loadSnapshotMeta(snapshotId);
    const github = await resolveGitHubAccess(meta);
    const dependencies = await resolveDependencyCheckouts(db, snapshotId);
    return cloneWithBaseRecovery(meta, github, dependencies, targetDirSeed, body);
}

/**
 * Clone for one activity, recovering ONCE from an unreachable recorded base SHA (a force-pushed/GC'd head the
 * previous run inherited). Left unhandled the run fails and never promotes, so every later push re-inherits the
 * same dead base and the branch wedges dark; recovering to the head's first parent lets it promote and advance
 * the active pointer to a reachable head. Only the primary repo's base triggers this (a dependency's degrades to
 * `unavailable`); a transient fetch failure is a different error and stays a hard failure.
 */
async function cloneWithBaseRecovery<T>(
    meta: SnapshotMeta,
    github: GitHubAccess,
    dependencies: Awaited<ReturnType<typeof resolveDependencyCheckouts>>,
    targetDirSeed: string,
    body: (context: SnapshotContext) => Promise<T>,
): Promise<T> {
    const cloneAndRun = (snapshot: SnapshotMeta) =>
        withCheckout(
            github,
            { headSha: snapshot.headSha, baseSha: snapshot.baseSha },
            dependencies,
            targetDirSeed,
            (codebase) => body(buildSnapshotContext(snapshot, github, codebase)),
        );

    try {
        return await cloneAndRun(meta);
    } catch (error) {
        if (!(error instanceof UnreachableBaseShaError)) throw error;
        const recoveredBaseSha = await recoverUnreachableBase(meta, github, error);
        return await cloneAndRun({ ...meta, baseSha: recoveredBaseSha });
    }
}

/**
 * Resolve a reachable base and persist it, so every stage that re-clones this run reads the healed coordinates.
 * Uses the head's first parent - remotely reachable by definition, being an ancestor of the just-pushed head. A
 * root commit with no parent falls back to head itself (an empty self-diff), which still satisfies the
 * non-null-base invariant so the run can promote.
 */
async function recoverUnreachableBase(
    meta: SnapshotMeta,
    github: GitHubAccess,
    error: UnreachableBaseShaError,
): Promise<string> {
    const logger = rootLogger.child({ name: "recoverUnreachableBase" });
    logger.warn("Recovering an unreachable base SHA to the head's first parent", {
        snapshot: { snapshotId: meta.snapshotId },
        extra: { unreachableBaseSha: error.baseSha, headSha: meta.headSha },
    });

    const headCommit = await github.githubClient.getCommit(meta.githubRepositoryId, meta.headSha);
    const recoveredBaseSha = headCommit.parents[0] ?? meta.headSha;
    await db.branchSnapshot.update({ where: { id: meta.snapshotId }, data: { baseSha: recoveredBaseSha } });

    logger.info("Recovered base SHA persisted onto the snapshot", {
        snapshot: { snapshotId: meta.snapshotId },
        extra: { recoveredBaseSha, isRootCommit: headCommit.parents.length === 0 },
    });
    return recoveredBaseSha;
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
