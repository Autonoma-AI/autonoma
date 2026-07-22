import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";

const MAX_LINES = 2000;
// A line cap alone is useless against minified bundles or lockfiles (megabytes
// on one line). Every result is retained in the agent's conversation for the
// whole step, so an uncapped read is a straight path to heap exhaustion.
const MAX_OUTPUT_BYTES = 256 * 1024;

const inputSchema = z.object({
    filePath: z.string().describe("Path to the file (absolute or relative to working directory)"),
    offset: z.number().int().min(0).optional().describe("Line number to start reading from (0-based)"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
});

export interface ReadFileResult {
    path?: string;
    content?: string;
    totalLines?: number;
    linesShown?: number;
    startLine?: number;
    endLine?: number;
    error?: string;
}

export function resolveSandboxedPath(
    workingDirectory: string,
    filePath: string,
): { absolutePath: string; relativePath: string } | { error: string } {
    const absolutePath = resolve(workingDirectory, filePath);
    const relativePath = relative(workingDirectory, absolutePath);

    if (relativePath.startsWith("..")) {
        return { error: "Cannot read files outside the working directory" };
    }

    return { absolutePath, relativePath };
}

export function sliceLines(
    content: string,
    offset: number,
    limit: number,
): { numbered: string; totalLines: number; linesShown: number; startLine: number; endLine: number } {
    const allLines = content.split("\n");
    const lines = allLines.slice(offset, offset + limit);
    const numbered = lines.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");

    return {
        numbered,
        totalLines: allLines.length,
        linesShown: lines.length,
        startLine: offset + 1,
        endLine: offset + lines.length,
    };
}

export async function executeReadFile(
    workingDirectory: string,
    filePath: string,
    offset?: number,
    limit?: number,
): Promise<ReadFileResult> {
    const resolved = resolveSandboxedPath(workingDirectory, filePath);
    if ("error" in resolved) return resolved;

    try {
        const content = await readFile(resolved.absolutePath, "utf-8");
        const sliced = sliceLines(content, offset ?? 0, limit ?? MAX_LINES);
        if (sliced.numbered.length > MAX_OUTPUT_BYTES) {
            sliced.numbered =
                sliced.numbered.slice(0, MAX_OUTPUT_BYTES) +
                `\n... [output truncated at ${Math.round(MAX_OUTPUT_BYTES / 1024)}KB - request a smaller offset/limit range]`;
        }

        return {
            path: resolved.relativePath,
            content: sliced.numbered,
            totalLines: sliced.totalLines,
            linesShown: sliced.linesShown,
            startLine: sliced.startLine,
            endLine: sliced.endLine,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to read file: ${message}` };
    }
}

export function buildReadFileTool(workingDirectory: string) {
    return tool({
        description: "Read file contents with line numbers. Use offset and limit for large files.",
        inputSchema,
        execute: (input) => executeReadFile(workingDirectory, input.filePath, input.offset, input.limit),
    });
}
