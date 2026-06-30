import { type Tool, tool } from "ai";
import { z } from "zod";
import type { CodebaseReader } from "../classify/dependencies";
import { createGitDiffTool, createGrepCodeTool, createReadCodeTool } from "../classify/tools";
import type { TestCatalog } from "../db/test-catalog";
import { type ToolCap, createToolBudget } from "../tool-output";
import type { SelectorDeps } from "./dependencies";

/** The slice of TestCatalog the get_test_plan tool needs (testable without a real Prisma client). */
type PlanReader = Pick<TestCatalog, "getSnapshotPlan">;

const DIFF_STAT_MAX_CHARS = 24_000;
const TEST_PLAN_MAX_CHARS = 40_000;

/** The changed-files summary for the PR (git diff --stat). */
export function createDiffStatTool(codebase: CodebaseReader, cap: ToolCap): Tool {
    return tool({
        description: "The PR's changed-files summary (git diff --stat) - the files and line counts that changed.",
        inputSchema: z.object({}),
        execute: async () => {
            try {
                return cap((await codebase.diffStat()) || "(no changes)", {
                    tool: "diff_stat",
                    mode: "narrow",
                    maxChars: DIFF_STAT_MAX_CHARS,
                    hint: "use git_diff on a specific path instead of the whole summary.",
                });
            } catch (error) {
                return `could not read diff stat: ${error instanceof Error ? error.message : String(error)}`;
            }
        },
    });
}

/** Read one test's FULL plan (steps), to confirm a shortlisted candidate is really affected by the diff. */
export function createGetTestPlanTool(catalog: PlanReader, snapshotId: string, cap: ToolCap): Tool {
    return tool({
        description:
            "Read the full plan (Setup / Steps / Verification) of one test by its slug, to confirm whether the diff actually affects what it does. The catalog of test descriptions is already in your prompt.",
        inputSchema: z.object({ slug: z.string() }),
        execute: async ({ slug }) => {
            try {
                return cap((await catalog.getSnapshotPlan(snapshotId, slug)) ?? `no plan found for "${slug}"`, {
                    tool: "get_test_plan",
                    mode: "narrow",
                    maxChars: TEST_PLAN_MAX_CHARS,
                    hint: "this plan is unusually large; rely on its one-line catalog description instead.",
                });
            } catch (error) {
                return `could not read test plan: ${error instanceof Error ? error.message : String(error)}`;
            }
        },
    });
}

/** Assemble the selector tool set (codebase tools reused from the classifier + the get-test-plan tool). */
export function buildSelectorTools(deps: SelectorDeps): Record<string, Tool> {
    const cap = createToolBudget();
    return {
        diff_stat: createDiffStatTool(deps.codebase, cap),
        git_diff: createGitDiffTool(deps.codebase, cap),
        read_code: createReadCodeTool(deps.codebase, cap),
        grep_code: createGrepCodeTool(deps.codebase, cap),
        get_test_plan: createGetTestPlanTool(deps.catalog, deps.snapshotId, cap),
    };
}
