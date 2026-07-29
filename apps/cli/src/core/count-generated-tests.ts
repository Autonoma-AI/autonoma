import { listTestFiles } from "./test-files";

/**
 * How many E2E tests the run produced - the same set the upload sends, so the
 * number the user is shown is the number that reaches the platform.
 */
export async function countGeneratedTests(outputDir: string): Promise<number> {
    return (await listTestFiles(outputDir)).length;
}
