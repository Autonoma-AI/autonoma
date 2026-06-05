import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { CodebaseLoop } from "./codebase-loop";

const MAX_TOOL_OUTPUT_CHARS = 60_000;
/**
 * Aggregate content budget across all files in a single call. Per-file content is capped
 * separately at {@link MAX_TOOL_OUTPUT_CHARS}; this caps the sum. Once the budget is exhausted,
 * remaining files are returned as a truncation marker so the agent can re-request them
 * individually.
 */
const MAX_TOTAL_OUTPUT_CHARS = 200_000;

const fileRequestSchema = z.object({
    path: z.string().describe("Path relative to the repository root, e.g. 'src/components/Login.tsx'"),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
});

const readFilesInputSchema = z.object({
    files: z
        .array(fileRequestSchema)
        .min(1)
        .describe("List of files to read. Batch every path you need into one call."),
});

type ReadFilesInput = z.infer<typeof readFilesInputSchema>;
type FileRequest = z.infer<typeof fileRequestSchema>;

type FileResult = { ok: true; content: string } | { ok: false; error: string };

interface ReadFilesOutput {
    results: Record<string, FileResult>;
}

/**
 * Read one or more files from the codebase under a {@link CodebaseLoop}. The
 * underlying filesystem operation may fail (ENOENT, permission denied) - those
 * are returned as success-shaped per-path failures rather than thrown errors,
 * so the model can decide whether to retry with a different path.
 */
export class ReadFilesTool extends AgentTool<ReadFilesInput, ReadFilesOutput, CodebaseLoop> {
    constructor() {
        super({
            name: "read_files",
            description:
                "Read one or more files from the application's source tree in a single call. " +
                "Pass every file you need in the `files` array - do not call this tool repeatedly for individual paths. " +
                "Each entry takes a path relative to the repository root and optional startLine/endLine (1-indexed, inclusive) to fetch a slice. " +
                "Returns a `results` object keyed by the requested path. " +
                `Per-file content is capped at ${MAX_TOOL_OUTPUT_CHARS} chars and total content across all files at ${MAX_TOTAL_OUTPUT_CHARS} chars; ` +
                "anything beyond the cap is replaced with a truncation marker.",
            inputSchema: readFilesInputSchema,
        });
    }

    protected async execute({ files }: ReadFilesInput, loop: CodebaseLoop): Promise<ReadFilesOutput> {
        const entries = await Promise.all(
            files.map(async (req): Promise<readonly [string, FileResult]> => [req.path, await readOne(loop, req)]),
        );

        const results: Record<string, FileResult> = {};
        let cumulativeChars = 0;
        for (const [path, result] of entries) {
            if (!result.ok) {
                results[path] = result;
                continue;
            }
            const remainingBudget = MAX_TOTAL_OUTPUT_CHARS - cumulativeChars;
            if (remainingBudget <= 0) {
                results[path] = aggregateBudgetExhausted();
                continue;
            }
            if (result.content.length > remainingBudget) {
                results[path] = {
                    ok: true,
                    content: `${result.content.slice(0, remainingBudget)}\n\n[...truncated by aggregate budget: only the first ${remainingBudget} chars of this file are returned because earlier files in the same call had already consumed most of the ${MAX_TOTAL_OUTPUT_CHARS}-char total budget. Re-request this path on its own to see the rest.]`,
                };
                cumulativeChars = MAX_TOTAL_OUTPUT_CHARS;
                continue;
            }
            results[path] = result;
            cumulativeChars += result.content.length;
        }
        return { results };
    }
}

function aggregateBudgetExhausted(): FileResult {
    return {
        ok: true,
        content: `[omitted: aggregate output budget of ${MAX_TOTAL_OUTPUT_CHARS} chars was already exhausted by earlier files in this call. Re-request this path on its own.]`,
    };
}

async function readOne(loop: CodebaseLoop, req: FileRequest): Promise<FileResult> {
    try {
        const content = await loop.codebase.readFile(req.path, { startLine: req.startLine, endLine: req.endLine });
        return { ok: true, content: truncate(content) };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

function truncate(content: string): string {
    if (content.length <= MAX_TOOL_OUTPUT_CHARS) return content;
    return `${content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[...truncated, file is longer than ${MAX_TOOL_OUTPUT_CHARS} chars; request specific line ranges to see more]`;
}
