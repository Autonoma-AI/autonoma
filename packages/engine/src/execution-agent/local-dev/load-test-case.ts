import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type z from "zod";
import type { TestCase } from "../agent";

export class LoadTestCaseError extends Error {
    constructor(cause: Error) {
        super(`Failed to load test case: ${cause.message}`, { cause });
    }
}

/**
 * Load a test case from a given markdown file.
 *
 * @param filePath - The path to the markdown file.
 * @param paramsSchema - The schema of the application data parameters. These will be read from the gray-matter frontmatter
 * @returns The test case, combining BaseTestCase fields with the application data.
 */
export async function loadTestCase<TApplicationData>(
    filePath: string,
    paramsSchema: z.Schema<TApplicationData>,
): Promise<TestCase & TApplicationData> {
    const content = await fs.readFile(filePath, "utf-8");
    const { data, content: body } = matter(content);

    // The name is the filename without the extension
    const name = path.basename(filePath, path.extname(filePath));

    const parseResult = paramsSchema.safeParse(data);
    if (!parseResult.success) throw new LoadTestCaseError(parseResult.error);

    return { name, prompt: body, ...parseResult.data };
}
