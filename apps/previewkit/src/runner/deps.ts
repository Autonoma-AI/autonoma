import { db } from "@autonoma/db";
import type { PreviewDeployEvent } from "@autonoma/workflow/activities";
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
 * Webhook close events arrive with `headSha: ""` - fall back to the environment
 * row's stored sha so the teardown commit status lands on the deployed commit.
 * Mirrors `resolveTeardownHeadSha` in the (Temporal) activity layer.
 */
async function resolveTeardownHeadSha(event: PreviewDeployEvent): Promise<PreviewDeployEvent> {
    if (event.headSha !== "") return event;
    const logger = rootLogger.child({ name: "resolveTeardownHeadSha" });
    const row = await db.previewkitEnvironment
        .findUnique({
            where: { repoFullName_prNumber: { repoFullName: event.repoFullName, prNumber: event.prNumber } },
            select: { headSha: true },
        })
        .catch((err: unknown) => {
            logger.warn("Failed to look up environment headSha for teardown; proceeding without it", {
                extra: { repo: event.repoFullName, pr: event.prNumber, err },
            });
            return null;
        });
    if (row == null) return event;
    return { ...event, headSha: row.headSha };
}
