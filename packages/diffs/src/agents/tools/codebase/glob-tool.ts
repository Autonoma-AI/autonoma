import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { CodebaseLoop } from "./codebase-loop";

const globInputSchema = z.object({
    pattern: z.string().describe("The glob pattern to match files against (e.g. '**/*.ts', 'src/**/*.tsx')"),
    cwd: z.string().optional().describe("Directory to search in, relative to the codebase root. Defaults to the root."),
});

type GlobInput = z.infer<typeof globInputSchema>;

interface GlobOutput {
    matches: string[];
    count: number;
}

/** Match files by glob under the codebase root. */
export class GlobTool extends AgentTool<GlobInput, GlobOutput, CodebaseLoop> {
    constructor() {
        super({
            name: "glob",
            description:
                "Find files in the application's source tree by glob pattern. " +
                "Returns paths relative to the codebase root (or to `cwd` if provided).",
            inputSchema: globInputSchema,
        });
    }

    protected async execute(input: GlobInput, loop: CodebaseLoop): Promise<GlobOutput> {
        const options = input.cwd != null ? { cwd: input.cwd } : {};
        const matches = await loop.codebase.glob(input.pattern, options);
        return { matches, count: matches.length };
    }
}
