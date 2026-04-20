import { db } from "@autonoma/db";
import { logger, runWithSentry } from "@autonoma/logger";
import { env } from "./env";
import { runGenerationReview } from "./run";

const generationIdArg = process.argv[2];
if (generationIdArg == null) {
    console.error("Usage: generation-reviewer <generationId>");
    process.exit(1);
}
const generationId: string = generationIdArg;

await runWithSentry(
    { name: "generation-reviewer", tags: { generationId }, dsn: env.SENTRY_DSN_GENERATION_REVIEWER },
    async () => {
        try {
            await runGenerationReview(generationId);
        } catch (error) {
            logger.fatal("Generation reviewer failed", error);

            try {
                await db.generationReview.update({
                    where: { generationId },
                    data: { status: "failed" },
                });
            } catch (updateError) {
                logger.error("Failed to update review status to failed", updateError);
            }

            throw error;
        }
    },
);
