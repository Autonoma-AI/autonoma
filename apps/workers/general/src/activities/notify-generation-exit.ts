import { handleGenerationExit } from "@autonoma/job-run-completion-notification/generation-exit";
import { logger as rootLogger } from "@autonoma/logger";
import type { NotifyGenerationExitInput } from "@autonoma/workflow/activities";

export async function notifyGenerationExit(input: NotifyGenerationExitInput): Promise<void> {
    const logger = rootLogger.child({ name: "notifyGenerationExit", testGenerationId: input.testGenerationId });
    logger.info("Sending generation exit notification");

    await handleGenerationExit(input.testGenerationId);

    logger.info("Generation exit notification sent");
}
