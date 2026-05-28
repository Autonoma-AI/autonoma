import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { GrepHit } from "../../../codebase";
import type { CodebaseLoop } from "./codebase-loop";

const grepInputSchema = z.object({
    pattern: z.string().describe("Regular expression to search for"),
    glob: z.string().optional().describe("Optional glob to restrict the search, e.g. 'src/**/*.tsx'"),
    maxResults: z.number().int().min(1).max(500).optional(),
});

type GrepInput = z.infer<typeof grepInputSchema>;

interface GrepOutput {
    hits: GrepHit[];
}

/**
 * Search the codebase for a regex pattern via ripgrep. No-match is a successful
 * operation that returns an empty `hits` array - the tool only throws on infra
 * failures (ripgrep missing, broken codebase root).
 */
export class GrepTool extends AgentTool<GrepInput, GrepOutput, CodebaseLoop> {
    constructor() {
        super({
            name: "grep",
            description:
                "Search the application's source tree for a regular expression (uses ripgrep). Returns up to 200 matches by default with file paths and line numbers.",
            inputSchema: grepInputSchema,
        });
    }

    protected async execute(input: GrepInput, loop: CodebaseLoop): Promise<GrepOutput> {
        const hits = await loop.codebase.grep(input.pattern, { glob: input.glob, maxResults: input.maxResults });
        return { hits };
    }
}
