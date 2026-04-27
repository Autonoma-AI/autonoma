import { runDiffsResolution } from "@autonoma/job-diffs/run-resolution";
import { logger as rootLogger } from "@autonoma/logger";
import type { ResolveDiffsInput, ResolveDiffsOutput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function resolveDiffs(input: ResolveDiffsInput): Promise<ResolveDiffsOutput> {
    const logger = rootLogger.child({ name: "resolveDiffs", snapshotId: input.snapshotId });
    logger.info("Starting diffs resolution", { runIds: input.runIds });

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        return await runDiffsResolution(input);
    } finally {
        clearInterval(heartbeat);
    }
}
