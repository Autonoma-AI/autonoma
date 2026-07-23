import { type PrismaClient, withAdvisoryLock } from "@autonoma/db";

/** The persisted state of the `Autonoma` check run for one PR head, read back when we update or inspect it. */
export interface GitHubCheckRunState {
    checkRunId: string;
    prNumber: number;
    conclusion?: string;
}

export interface UpsertGitHubCheckRunParams {
    repoFullName: string;
    prNumber: number;
    headSha: string;
    checkRunId: string;
    conclusion?: string;
}

/**
 * Idempotent store for the merge-gate check run, backed by the `github_check_run` table keyed by
 * `(repoFullName, headSha)`. A re-push/re-run for the same head reuses the same GitHub check-run id rather than
 * posting a duplicate, and the last `conclusion` we set is persisted so bypass detection can read it on merge.
 */
export interface GitHubCheckRunStore {
    getByHead(repoFullName: string, headSha: string): Promise<GitHubCheckRunState | undefined>;
    upsert(params: UpsertGitHubCheckRunParams): Promise<void>;
    setConclusion(repoFullName: string, headSha: string, conclusion: string): Promise<void>;
    /**
     * Serialize a read-post-persist section across processes with a Postgres advisory lock keyed by
     * `(repoFullName, headSha)`, so two concurrent webhook deliveries (or the API and the diffs worker) cannot
     * both create a GitHub check run for the same head.
     */
    runExclusive<T>(repoFullName: string, headSha: string, fn: () => Promise<T>): Promise<T>;
}

export function createGitHubCheckRunStore(db: PrismaClient): GitHubCheckRunStore {
    return {
        async getByHead(repoFullName, headSha) {
            const row = await db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName, headSha } },
                select: { checkRunId: true, prNumber: true, conclusion: true },
            });
            if (row == null) return undefined;
            return { checkRunId: row.checkRunId, prNumber: row.prNumber, conclusion: row.conclusion ?? undefined };
        },
        async upsert(params) {
            await db.gitHubCheckRun.upsert({
                where: { repoFullName_headSha: { repoFullName: params.repoFullName, headSha: params.headSha } },
                create: {
                    repoFullName: params.repoFullName,
                    prNumber: params.prNumber,
                    headSha: params.headSha,
                    checkRunId: params.checkRunId,
                    conclusion: params.conclusion,
                },
                update: { checkRunId: params.checkRunId, prNumber: params.prNumber, conclusion: params.conclusion },
            });
        },
        async setConclusion(repoFullName, headSha, conclusion) {
            await db.gitHubCheckRun.update({
                where: { repoFullName_headSha: { repoFullName, headSha } },
                data: { conclusion },
            });
        },
        runExclusive(repoFullName, headSha, fn) {
            return withAdvisoryLock(db, `merge-gate-check:${repoFullName}:${headSha}`, fn);
        },
    };
}
