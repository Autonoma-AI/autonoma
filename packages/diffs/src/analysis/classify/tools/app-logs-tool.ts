import { AgentTool, FixableToolError } from "@autonoma/ai";
import { causeMessage } from "@autonoma/errors";
import { z } from "zod";
import { truncateOutput } from "../../../agents/tools/truncate-output";

const MAX_CHARS = 24_000;

const DEFAULT_REGEX = "(?i)error|exception|econnrefused|etimedout|unauthorized|fatal|uncaught";

const NARROW_HINT = "Re-call get_app_logs with a tighter regex to see less.";

const appLogsInputSchema = z.object({
    regex: z.string().default(DEFAULT_REGEX),
});

type AppLogsInput = z.infer<typeof appLogsInputSchema>;

class AppLogsUnreadableError extends FixableToolError {
    constructor(
        public readonly regex: string,
        cause: unknown,
    ) {
        super(`Could not read the app logs matching /${regex}/: ${causeMessage(cause)}`);
    }

    override suggestFix(): string {
        return "Retry with a simpler regex if the pattern may be malformed; otherwise confirm the mechanism with run_script instead, and keep any claim that rests on an unread log line at LOW confidence.";
    }
}

/** App logs over the run window, filtered by a regex. */
export class AppLogsTool extends AgentTool<AppLogsInput, string> {
    constructor(private readonly loadAppLogs: (regex: string) => Promise<string>) {
        super({
            name: "get_app_logs",
            description:
                "The app's logs over the exact run window, filtered by a regex. An error here is a candidate, not a conclusion - confirm it blocked the failing step. " +
                `Output is capped at ${MAX_CHARS} characters; beyond that the head and tail are kept, so tighten the regex if you see a truncation marker.`,
            inputSchema: appLogsInputSchema,
        });
    }

    protected async execute({ regex }: AppLogsInput): Promise<string> {
        try {
            const logs = await this.loadAppLogs(regex);
            return truncateOutput(logs, MAX_CHARS, "logs", NARROW_HINT);
        } catch (cause) {
            throw new AppLogsUnreadableError(regex, cause);
        }
    }
}
