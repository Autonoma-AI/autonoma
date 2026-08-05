import { db } from "@autonoma/db";
import type { PreviewTeardownTarget } from "@autonoma/types";
import { markBuildSuperseded } from "../db";
import { logger as rootLogger } from "../logger";
import type { RunPreviewJobDeps } from "./run-preview-job";

/**
 * Real DB-backed {@link RunPreviewJobDeps} for the runner entry point. Kept out
 * of `run-preview-job.ts` so that module stays free of `@autonoma/db` and can be
 * unit-tested without the database env.
 */
export const defaultRunPreviewJobDeps: RunPreviewJobDeps = {
    markSuperseded: markBuildSuperseded,
    resolveTeardownHeadSha,
};

/**
 * A close webhook carries no sha, so fall back to the environment row's - the teardown commit status has to land
 * on the deployed commit. Still absent afterwards when there is no row, and the caller skips the status then.
 */
async function resolveTeardownHeadSha(target: PreviewTeardownTarget): Promise<PreviewTeardownTarget> {
    if (target.headSha != null) return target;
    const logger = rootLogger.child({ name: "resolveTeardownHeadSha" });
    const row = await db.previewkitEnvironment
        .findUnique({
            where: { repoFullName_prNumber: { repoFullName: target.repoFullName, prNumber: target.prNumber } },
            select: { headSha: true },
        })
        .catch((err: unknown) => {
            logger.warn("Failed to look up environment headSha for teardown; proceeding without it", {
                extra: { repo: target.repoFullName, pr: target.prNumber, err },
            });
            return null;
        });
    if (row == null) return target;
    return { ...target, headSha: row.headSha };
}
