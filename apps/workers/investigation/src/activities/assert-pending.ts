import { db } from "@autonoma/db";
import { assertSnapshotPending as assertSnapshotPendingImpl } from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
import type { AssertSnapshotPendingInput } from "@autonoma/workflow/activities";

/**
 * Fail the investigation immediately unless its target snapshot is a `processing` twin - a cheap status read
 * at the very top of the run, before the expensive clone in `selectInvestigationTests`. See
 * `assertSnapshotPending` in `@autonoma/investigation` for why the whole agent depends on a pending twin.
 */
export async function assertSnapshotPending(input: AssertSnapshotPendingInput): Promise<void> {
    const { snapshotId } = input;
    const logger = rootLogger.child({ name: "assertSnapshotPending", extra: { snapshotId } });
    await assertSnapshotPendingImpl(db, snapshotId);
    logger.info("Snapshot is a pending twin; proceeding with investigation");
}
