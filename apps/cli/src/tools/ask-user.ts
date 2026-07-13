import * as p from "@clack/prompts";
import { tool } from "ai";
import { z } from "zod";

export function buildAskUserTool() {
    return tool({
        description:
            "Ask the user a question ONLY when the answer is truly unknowable from the codebase. " +
            "Valid reasons: untyped JSON/JSONB field schemas, business rules not in code, config values not in source. " +
            "NEVER ask about: field names (read the schema), field types (read the ORM model), " +
            "enum values (read the code), relationships (read foreign keys), numeric values (read the seed data or defaults). " +
            "If you can find it by reading a file, DO NOT ask - read the file instead.",
        inputSchema: z.object({
            question: z
                .string()
                .describe(
                    "A clear, plain-language question. State exactly what you need to know and why you can't find it in code. " +
                        "BAD: 'What are the decimal values for checking_balance?' - GOOD: 'Your Account model has a metadata JSON column with no type definition. What fields go inside it?'",
                ),
        }),
        execute: async (input) => {
            // In non-interactive / no-TTY runs there is no human to answer, and
            // clack's prompt would block forever waiting on a TTY. Auto-skip so the
            // agent falls back to inferring the answer from the codebase.
            if (!process.stdin.isTTY) {
                return {
                    answer: "No interactive user is available (non-interactive run). Do not ask again - infer the answer by reading the relevant model/schema/service files in the codebase and proceed with your best judgment.",
                };
            }
            const answer = await p.text({ message: input.question });
            if (p.isCancel(answer)) return { answer: "User skipped this question" };
            return { answer };
        },
    });
}
