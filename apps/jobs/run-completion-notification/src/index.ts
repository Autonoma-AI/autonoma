import { logger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { handleGenerationExit } from "./handlers/generation-exit";
import { handleRunExit } from "./handlers/run-exit";
import { initializeSentry } from "./instrumentation";

initializeSentry();

const VALID_COMMANDS = ["generation-exit", "run-exit"] as const;
type Command = (typeof VALID_COMMANDS)[number];

const args = process.argv.slice(2);
const command = args[0] as Command | undefined;

if (command == null || !VALID_COMMANDS.includes(command)) {
    console.error("Usage: run-completion-notification <generation-exit|run-exit> <entityId>");
    process.exit(1);
}

const entityIdArg = args[1];
if (entityIdArg == null) {
    console.error("Usage: run-completion-notification <generation-exit|run-exit> <entityId>");
    process.exit(1);
}
const entityId: string = entityIdArg;

async function main() {
    logger.info("Starting run completion notification job", { command, entityId });

    if (command === "generation-exit") {
        await handleGenerationExit(entityId);
    } else {
        await handleRunExit(entityId);
    }
}

try {
    await Sentry.withScope(async (scope) => {
        scope.setTag("notification_command", command);
        scope.setTag("entity_id", entityId);
        await main();
    });
    process.exit(0);
} catch (error) {
    logger.error("Notification job failed", error, { command, entityId });
    Sentry.captureException(error);
    await Sentry.flush(2000);
    process.exit(1);
}
