import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { DirectoryEntry } from "../../../codebase";
import type { CodebaseLoop } from "./codebase-loop";

const listDirectoryInputSchema = z.object({
    path: z.string().default(".").describe("Path relative to the repository root. Defaults to the root."),
});

type ListDirectoryInput = z.infer<typeof listDirectoryInputSchema>;

interface ListDirectoryOutput {
    entries: DirectoryEntry[];
}

/** List entries in a directory under the codebase root. */
export class ListDirectoryTool extends AgentTool<ListDirectoryInput, ListDirectoryOutput, CodebaseLoop> {
    constructor() {
        super({
            name: "list_directory",
            description: "List entries in a directory inside the application's source tree.",
            inputSchema: listDirectoryInputSchema,
        });
    }

    protected async execute({ path }: ListDirectoryInput, loop: CodebaseLoop): Promise<ListDirectoryOutput> {
        const entries = await loop.codebase.listDirectory(path);
        return { entries };
    }
}
