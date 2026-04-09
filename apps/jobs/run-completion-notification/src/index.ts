import { logger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { handleGenerationExit } from "./handlers/generation-exit";
import { handleMarkGenerationFailed } from "./handlers/mark-generation-failed";
import { initializeSentry } from "./instrumentation";

initializeSentry();

const VALID_COMMANDS = ["generation-exit", "mark-failed"] as const;
type Command = (typeof VALID_COMMANDS)[number];

const args = process.argv.slice(2);
const command = args[0] as Command | undefined;

if (command == null || !VALID_COMMANDS.includes(command)) {
    console.error("Usage: run-completion-notification <generation-exit|mark-failed> <generationId>");
    process.exit(1);
}

const generationIdArg = args[1];
if (generationIdArg == null) {
    console.error("Usage: run-completion-notification <generation-exit|mark-failed> <generationId>");
    process.exit(1);
}
const generationId: string = generationIdArg;

async function main() {
    logger.info("Starting run completion notification job", { command, generationId });

    if (command === "mark-failed") {
        await handleMarkGenerationFailed(generationId);
    } else {
        await handleGenerationExit(generationId);
    }
}

try {
    await Sentry.withScope(async (scope) => {
        scope.setTag("notification_command", command);
        scope.setTag("generation_id", generationId);
        await main();
    });
    process.exit(0);
} catch (error) {
    logger.error("Notification job failed", error, { command, generationId });
    Sentry.captureException(error);
    await Sentry.flush(2000);
    process.exit(1);
}
