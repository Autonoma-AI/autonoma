import { getTemporalClient } from "@autonoma/workflow";

// Dev-only: terminate an investigation workflow (e.g. to re-run after a fix). Connects to whatever Temporal
// the env points at (TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE). Usage:
// tsx --env-file=<env> scripts/terminate-investigation.ts <snapshotId>

async function main(): Promise<void> {
    const snapshotId = process.argv[2];
    if (snapshotId == null || snapshotId === "") throw new Error("usage: terminate-investigation.ts <snapshotId>");

    const client = await getTemporalClient();
    await client.workflow.getHandle(`investigation-${snapshotId}`).terminate("re-testing after heartbeat fix");
    console.log(`TERMINATED investigation-${snapshotId}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
