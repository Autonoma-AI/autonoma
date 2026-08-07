import { ApplicationArchitecture, TriggerSource, db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { BranchAlreadyOpenError, type OpenSnapshot, SourceMovedError, TestSuiteStore } from "@autonoma/test-suite";
import type {
    OpenAnalysisRunInput,
    OpenAnalysisRunOutput,
    OpenAnalysisSkipReason,
} from "@autonoma/workflow/activities";
import { settleAnalysisRunState } from "./settle-analysis-run-state";

const SUPERSEDE_REASON = "Superseded by a newer analysis request";
/** How many times an open re-resolves after losing to a concurrent settlement or promotion. */
const MAX_OPEN_ATTEMPTS = 3;

const logger = rootLogger.child({ name: "openAnalysisRun" });

export class NoAnalysisBaseError extends Error {
    constructor(branchId: string) {
        super(`Branch ${branchId} has no analysis base: no snapshot to fork from, and the trigger knew no base sha`);
    }
}

/**
 * Deliberately URL-free: a previewkit run opens its run before the preview exists, since whether one ever will is
 * what the build gate is about to decide. A customer-deployed run opens it with the deployment already recorded.
 */
export async function openAnalysisRun(input: OpenAnalysisRunInput): Promise<OpenAnalysisRunOutput> {
    const { branchId, headSha } = input;
    logger.info("Opening the analysis run", { branch: { branchId }, extra: { headSha } });

    // Asked before anything is created: an application no run can say anything about is refused here rather than
    // aborting midway, once the AnalysisJob, the snapshot and a clone already exist.
    const unsupported = await findUnsupportedReason(branchId);
    if (unsupported != null) {
        logger.info("Run skipped: the application can produce no test work", {
            branch: { branchId },
            extra: { reason: unsupported },
        });
        return { skipped: true, reason: unsupported };
    }

    const store = new TestSuiteStore(db);
    const resolved = await store.resolveSource({ branchId, headSha, fallbackBaseSha: input.baseSha });

    // A re-delivered trigger for an already-analyzed head has nothing new to diff. A previewkit run still builds for
    // it - the customer asked for a fresh preview of a commit we have already judged - so this reports the skip
    // rather than suppressing the run outright.
    if (resolved.alreadyAnalyzed) {
        logger.info("Run skipped: head already analyzed", { branch: { branchId } });
        return { skipped: true, reason: "already_analyzed" };
    }
    if (resolved.source == null || resolved.baseSha == null) throw new NoAnalysisBaseError(branchId);

    const snapshot = await openSuperseding(store, branchId, headSha, input.baseSha);

    logger.info("Analysis run opened", {
        branch: { branchId },
        snapshot: { snapshotId: snapshot.snapshotId, headSha, baseSha: snapshot.baseSha },
    });
    return { skipped: false, snapshotId: snapshot.snapshotId };
}

/**
 * A branch holds at most one open snapshot, so opening supersedes whatever run was in flight. No workflow to
 * cancel: runs are keyed on the branch with terminate-existing, so Temporal has already displaced the predecessor -
 * but termination runs no workflow code, so its own settlement never fires. Hence the settle here.
 *
 * The source is resolved per attempt, never once up front: both the settlement this function performs and a
 * concurrent run's promotion move the branch on, and `openSnapshot` refuses a source resolved before either.
 */
async function openSuperseding(
    store: TestSuiteStore,
    branchId: string,
    headSha: string,
    fallbackBaseSha: string | undefined,
): Promise<OpenSnapshot> {
    const open = async () => {
        const { source } = await store.resolveSource({ branchId, headSha, fallbackBaseSha });
        if (source == null) throw new NoAnalysisBaseError(branchId);
        return store.openSnapshot({
            branchId,
            headSha,
            source,
            trigger: TriggerSource.WEBHOOK,
            // The job is created with the snapshot, not after it: a run whose snapshot exists but whose job does
            // not would settle against nothing, since the settlement matches on a `running` job.
            onOpened: async (tx, identity) => {
                await tx.analysisJob.create({
                    data: {
                        snapshotId: identity.snapshotId,
                        // The branch owns the organization, so the job is scoped to whoever owns the snapshot
                        // rather than to whatever the trigger believed.
                        organizationId: identity.organizationId,
                        status: "running",
                        startedAt: new Date(),
                    },
                });
            },
        });
    };

    for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt++) {
        try {
            return await open();
        } catch (error) {
            if (error instanceof BranchAlreadyOpenError) {
                logger.info("Superseding the pending snapshot and its in-flight pipeline", {
                    branch: { branchId },
                    snapshot: { snapshotId: error.pendingSnapshotId },
                });
                await settleAnalysisRunState({
                    db,
                    snapshotId: error.pendingSnapshotId,
                    outcome: { kind: "superseded", reason: SUPERSEDE_REASON },
                });
                continue;
            }
            if (error instanceof SourceMovedError) {
                logger.info("Another run promoted while this one was resolving its source; re-resolving", {
                    branch: { branchId },
                    extra: { attempt, actualActiveSnapshotId: error.actualActiveSnapshotId },
                });
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Branch ${branchId} kept moving under ${MAX_OPEN_ATTEMPTS} attempts to open a snapshot`);
}

/** The branch's application, when it is one no analysis run could reach a verdict on. */
async function findUnsupportedReason(branchId: string): Promise<OpenAnalysisSkipReason | undefined> {
    const branch = await db.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { application: { select: { architecture: true, _count: { select: { folders: true } } } } },
    });

    if (branch.application.architecture !== ApplicationArchitecture.WEB) return "unsupported_architecture";
    // A TestCase requires a folder, so no folders means no suite to draw affected tests from AND nowhere for the
    // agent to author a new one - every run would reach the same predetermined empty selection.
    if (branch.application._count.folders === 0) return "no_test_folders";
    return undefined;
}
