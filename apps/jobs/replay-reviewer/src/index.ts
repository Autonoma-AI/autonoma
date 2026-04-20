import { db } from "@autonoma/db";
import { logger, runWithSentry } from "@autonoma/logger";
import { env } from "./env";
import { runReplayReview } from "./run";

const runIdArg = process.argv[2];
if (runIdArg == null) {
    console.error("Usage: replay-reviewer <runId>");
    process.exit(1);
}
const runId: string = runIdArg;

await runWithSentry({ name: "replay-reviewer", tags: { runId }, dsn: env.SENTRY_DSN_REPLAY_REVIEWER }, async () => {
    try {
        await runReplayReview(runId);
    } catch (error) {
        logger.fatal("Replay reviewer failed", error);

        try {
            await db.runReview.update({
                where: { runId },
                data: { status: "failed" },
            });
        } catch (updateError) {
            logger.error("Failed to update review status to failed", updateError);
        }

        throw error;
    }
});
