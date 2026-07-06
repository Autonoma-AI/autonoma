import type { PrismaClient } from "@autonoma/db";

/** The status a detached investigation twin holds for its whole run - the only status the agent may target. */
const PENDING_STATUS = "processing";

/**
 * Throw unless `snapshotId` is a `processing` twin. The entire investigation assumes it runs against the
 * detached, still-pending twin that `maybeTriggerInvestigation` creates: selection reads the twin's frozen
 * baseline suite, and the persist / recipe-repair steps stage edits onto it through `SnapshotDraft`, which
 * requires `processing`. Point the workflow at an `active` diffs snapshot by mistake (e.g. a hand-started
 * `investigation-<diffsSnapshotId>` that skipped twin creation) and nothing catches it until persist throws
 * `SnapshotNotPendingError` - after selection and the browser runs have already burned scarce activity slots.
 * Calling this at the top of the run turns that slow, confusing failure into an instant, clearly worded one.
 */
export async function assertSnapshotPending(db: PrismaClient, snapshotId: string): Promise<void> {
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: { status: true },
    });

    if (snapshot == null) {
        throw new Error(`Investigation snapshot ${snapshotId} not found`);
    }
    if (snapshot.status !== PENDING_STATUS) {
        throw new Error(
            `Investigation must target a processing twin, but snapshot ${snapshotId} is "${snapshot.status}". ` +
                `Trigger through maybeTriggerInvestigation (it creates a detached twin and starts the workflow on ` +
                `that twin's id) - never start the workflow against a diffs snapshot id.`,
        );
    }
}
