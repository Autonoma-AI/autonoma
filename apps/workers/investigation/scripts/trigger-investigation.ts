import { triggerInvestigationJob } from "@autonoma/workflow";

// Dev-only: manually start the investigation workflow for a snapshot (the shadow trigger is normally fired
// by the API alongside the diffs job). Connects to whatever Temporal the env points at (TEMPORAL_ADDRESS /
// TEMPORAL_NAMESPACE). Usage: tsx --env-file=<env> scripts/trigger-investigation.ts <snapshotId>

async function main(): Promise<void> {
    const snapshotId = process.argv[2];
    if (snapshotId == null || snapshotId === "") throw new Error("usage: trigger-investigation.ts <snapshotId>");

    await triggerInvestigationJob({ snapshotId });
    console.log(`TRIGGERED investigation workflow for snapshot ${snapshotId} (workflowId investigation-${snapshotId})`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
