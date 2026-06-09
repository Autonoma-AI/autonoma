import type { VideoProcessor } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { type Codebase, ReplayReviewer, StorageEvidenceLoader, openModelSession } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import type { ReplayVerdict } from "@autonoma/types";
import { DiffJobContextLoader } from "../diff-job-context-loader";
import { RunReviewPersister } from "./persister";

export interface RunReplayReviewDeps {
    codebase: Codebase;
    videoProcessor?: VideoProcessor;
}

export interface RunReplayReviewResult {
    status: "completed" | "failed" | "skipped";
    verdict?: ReplayVerdict;
    reviewId?: string;
    organizationId?: string;
    finalScreenshotKey?: string;
    videoKey?: string;
}

/**
 * Production entry point: failure-only (skips runs whose status is not
 * "failed"), idempotent against an already-completed review, persists the
 * verdict transactionally.
 *
 * Local-CLI / read-only usage **does not go through this function**. It
 * composes the building blocks directly (`DiffJobContextLoader` +
 * `ReplayReviewer`) so the reviewer implementations stay free of
 * persistence-policy flags.
 */
export async function runReplayReview(runId: string, deps: RunReplayReviewDeps): Promise<RunReplayReviewResult> {
    logger.info("Starting replay review", { runId });

    const run = await db.run.findUniqueOrThrow({
        where: { id: runId },
        select: {
            status: true,
            organizationId: true,
            runReview: { select: { id: true, status: true } },
        },
    });

    if (run.status !== "failed") {
        logger.info("Run is not failed - skipping review", { runId, status: run.status });
        return { status: "skipped" };
    }

    if (run.runReview?.status === "completed") {
        logger.info("Skipping - completed review already exists", { runId });
        return { status: "skipped" };
    }

    if (run.runReview == null) {
        await db.runReview.create({
            data: { runId, organizationId: run.organizationId },
        });
    }

    const session = openModelSession();
    const model = session.getModel({ model: "smart-visual", tag: "replay-review" });

    const context = await new DiffJobContextLoader(db).load(runId);

    const evidenceLoader = new StorageEvidenceLoader(S3Storage.createFromEnv());
    const reviewer = new ReplayReviewer({
        model,
        evidenceLoader,
        videoProcessor: deps.videoProcessor,
    });
    let verdict: ReplayVerdict | undefined;
    try {
        const runOutcome = await reviewer.run({ context, codebase: deps.codebase });
        verdict = runOutcome.result;
    } catch (err) {
        logger.warn("Replay review did not produce a verdict", {
            runId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    const persister = new RunReviewPersister();

    if (verdict == null) {
        await persister.markFailed(runId);
        return { status: "failed" };
    }

    const { reviewId } = await persister.persist({
        runId,
        verdict,
        finalScreenshotKey: context.finalScreenshotKey,
        videoKey: context.videoS3Key,
        costCollector: session.costCollector,
    });

    return {
        status: "completed",
        verdict,
        reviewId,
        organizationId: context.organizationId,
        finalScreenshotKey: context.finalScreenshotKey,
        videoKey: context.videoS3Key,
    };
}
