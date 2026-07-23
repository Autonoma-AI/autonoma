import { logger } from "@autonoma/logger";
import { sleep } from "@autonoma/utils/sleep";
import { tool } from "ai";
import z from "zod";

export function buildWaitTool() {
    return tool({
        description:
            "Use this tool to wait for a period of time. " +
            "This will not be recorded as a step, just use it when there is a loading screen.",
        inputSchema: z.object({
            seconds: z.number().describe("The number of seconds to wait"),
        }),
        execute: async (input: { seconds: number }) => {
            logger.info("Waiting for", { seconds: input.seconds });

            await sleep(input.seconds * 1000);
        },
    });
}
