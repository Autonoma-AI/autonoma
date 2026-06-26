import { type Tool, tool } from "ai";
import { z } from "zod";
import type { CodebaseReader } from "../classify/dependencies";
import { createGitDiffTool, createGrepCodeTool, createReadCodeTool } from "../classify/tools";
import type { TestCatalog } from "../db/test-catalog";
import type { SelectorDeps } from "./dependencies";

/** The slice of TestCatalog the get_test_plan tool needs (testable without a real Prisma client). */
type PlanReader = Pick<TestCatalog, "getLatestPlan">;

/** The changed-files summary for the PR (git diff --stat). */
export function createDiffStatTool(codebase: CodebaseReader): Tool {
    return tool({
        description: "The PR's changed-files summary (git diff --stat) - the files and line counts that changed.",
        inputSchema: z.object({}),
        execute: async () => {
            try {
                return (await codebase.diffStat()) || "(no changes)";
            } catch (error) {
                return `could not read diff stat: ${error instanceof Error ? error.message : String(error)}`;
            }
        },
    });
}

/** Read one test's FULL plan (steps), to confirm a shortlisted candidate is really affected by the diff. */
export function createGetTestPlanTool(catalog: PlanReader, applicationId: string): Tool {
    return tool({
        description:
            "Read the full plan (Setup / Steps / Verification) of one test by its slug, to confirm whether the diff actually affects what it does. The catalog of test descriptions is already in your prompt.",
        inputSchema: z.object({ slug: z.string() }),
        execute: async ({ slug }) => {
            try {
                return (await catalog.getLatestPlan(applicationId, slug)) ?? `no plan found for "${slug}"`;
            } catch (error) {
                return `could not read test plan: ${error instanceof Error ? error.message : String(error)}`;
            }
        },
    });
}

/** Assemble the selector tool set (codebase tools reused from the classifier + the get-test-plan tool). */
export function buildSelectorTools(deps: SelectorDeps): Record<string, Tool> {
    return {
        diff_stat: createDiffStatTool(deps.codebase),
        git_diff: createGitDiffTool(deps.codebase),
        read_code: createReadCodeTool(deps.codebase),
        grep_code: createGrepCodeTool(deps.codebase),
        get_test_plan: createGetTestPlanTool(deps.catalog, deps.applicationId),
    };
}
