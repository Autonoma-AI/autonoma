import { readdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { tool } from "ai";
import { minimatch } from "minimatch";
import { z } from "zod";
import { loadGitignorePatterns } from "../core/gitignore";

interface TreeEntry {
    name: string;
    type: "file" | "dir";
    children?: TreeEntry[];
}

function buildMatcher(patterns: string[]): (path: string) => boolean {
    const positive = patterns.filter((p) => !p.startsWith("!"));
    const negative = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));

    return (path: string) => {
        const ignored = positive.some((p) => minimatch(path, p, { dot: true }));
        if (!ignored) return false;
        const restored = negative.some((p) => minimatch(path, p, { dot: true }));
        return !restored;
    };
}

async function buildTree(
    dirPath: string,
    maxDepth: number,
    currentDepth: number,
    isIgnored?: (relativePath: string) => boolean,
    relativeBase?: string,
): Promise<TreeEntry[]> {
    if (currentDepth >= maxDepth) return [];

    let rawEntries: string[];
    try {
        rawEntries = await readdir(dirPath);
    } catch {
        return [];
    }

    const withTypes: { name: string; isDir: boolean }[] = [];
    for (const name of rawEntries) {
        try {
            const s = await stat(join(dirPath, name));
            withTypes.push({ name, isDir: s.isDirectory() });
        } catch {
            withTypes.push({ name, isDir: false });
        }
    }

    withTypes.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
    });

    const result: TreeEntry[] = [];

    for (const entry of withTypes) {
        const entryRelPath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;

        if (isIgnored) {
            const checkPath = entry.isDir ? `${entryRelPath}/` : entryRelPath;
            if (isIgnored(checkPath) || isIgnored(entryRelPath)) continue;
        }

        if (entry.isDir) {
            const children = await buildTree(
                join(dirPath, entry.name),
                maxDepth,
                currentDepth + 1,
                isIgnored,
                entryRelPath,
            );
            result.push({ name: entry.name, type: "dir", children });
        } else {
            result.push({ name: entry.name, type: "file" });
        }
    }

    return result;
}

function renderTree(entries: TreeEntry[], prefix = ""): string {
    const lines: string[] = [];

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const isLast = i === entries.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const childPrefix = isLast ? "    " : "│   ";

        if (entry.type === "dir") {
            const suffix = entry.children?.length ? "/" : "/ (empty)";
            lines.push(`${prefix}${connector}${entry.name}${suffix}`);
            if (entry.children?.length) {
                lines.push(renderTree(entry.children, prefix + childPrefix));
            }
        } else {
            lines.push(`${prefix}${connector}${entry.name}`);
        }
    }

    return lines.join("\n");
}

export async function buildListDirectoryTool(workingDirectory: string) {
    const seen = new Set<string>();
    const patterns = await loadGitignorePatterns(workingDirectory);
    const isIgnored = buildMatcher(patterns);

    return tool({
        description:
            "List directory structure as a tree. Use this for an overview of the project layout. " +
            "Start at the root (path='.') with depth 3, then increase depth or narrow path if needed. " +
            "Do NOT call this on every subdirectory - use glob to find specific files instead. " +
            "Returns cached result if the same path+depth was already requested.",
        inputSchema: z.object({
            path: z.string().default(".").describe("Directory path relative to project root. Defaults to root."),
            depth: z.number().min(1).max(15).default(10).describe("Max depth to traverse (1-15). Default 10."),
            gitignore: z
                .boolean()
                .describe(
                    "Whether to respect the gitignore or to ignore it. true will respect it. false " +
                        "will ignore it. Default true",
                )
                .default(true),
        }),
        execute: async (input) => {
            const cacheKey = `${input.path}:${input.depth}`;
            if (seen.has(cacheKey)) {
                return {
                    error: `Already listed ${input.path} at depth ${input.depth}. Use glob to find specific files, or read_file to read a known file.`,
                };
            }
            seen.add(cacheKey);

            const targetDir = input.path === "." ? workingDirectory : join(workingDirectory, input.path);

            try {
                const s = await stat(targetDir);
                if (!s.isDirectory()) {
                    return { error: `Not a directory: ${input.path}` };
                }
            } catch {
                return { error: `Directory not found: ${input.path}` };
            }

            const relBase = targetDir === workingDirectory ? "" : relative(workingDirectory, targetDir);
            const maybeIgnored = input.gitignore ? isIgnored : undefined;

            const tree = await buildTree(targetDir, input.depth, 0, maybeIgnored, relBase || undefined);
            let rendered = renderTree(tree);
            // The tree is retained in the conversation until the step ends;
            // an uncapped listing of a big repo is a heap-exhaustion vector.
            const MAX_TREE_BYTES = 128 * 1024;
            if (rendered.length > MAX_TREE_BYTES) {
                rendered =
                    rendered.slice(0, MAX_TREE_BYTES) + "\n... [tree truncated - list a subdirectory or reduce depth]";
            }
            const relPath = relative(workingDirectory, targetDir) || ".";

            return {
                path: relPath,
                depth: input.depth,
                tree: `${relPath}/\n${rendered}`,
            };
        },
    });
}
