import { z } from "zod";
import { analysisIssueKindSchema, analysisIssueSeveritySchema } from "./analysis";

/**
 * The three places a fix can live. THE SAME enum as `AnalysisIssue.kind`, aliased rather than re-declared - the
 * plan is built out of those rows, so a second copy could only ever drift from the thing it describes.
 *
 * The split is the whole point of the fix plan: routing on it is what lets one agent pass clear a mixed backlog,
 * because each kind is repaired with a different set of MCP tools and only one of them is a change to the code.
 *
 * - `bug`         - the app misbehaved. Fixed in the repo.
 * - `environment` - the preview could not run. Fixed with the secret / config tools, no repo change.
 * - `scenario`    - the test data was missing or wrong. Fixed with the recipe tools, no redeploy.
 */
export const suiteHealthFixKindSchema = analysisIssueKindSchema;
export type SuiteHealthFixKind = z.infer<typeof suiteHealthFixKindSchema>;

/** Also an alias, for the same reason: these are `AnalysisIssue.severity` values, not a parallel scale. */
export const suiteHealthFixSeveritySchema = analysisIssueSeveritySchema;
export type SuiteHealthFixSeverity = z.infer<typeof suiteHealthFixSeveritySchema>;

/** One unresolved finding: what is wrong, how bad, and how long it has sat there. */
export const suiteHealthFixIssueSchema = z.object({
    id: z.string(),
    kind: suiteHealthFixKindSchema,
    severity: suiteHealthFixSeveritySchema,
    title: z.string(),
    ageDays: z.number().int(),
});
export type SuiteHealthFixIssue = z.infer<typeof suiteHealthFixIssueSchema>;

/**
 * Where a pull request sits. `main` is not a pull-request state - it is the app's main branch, which carries
 * findings of its own and is the most important thing in the list when it does.
 */
export const suiteHealthFixBranchStateSchema = z.enum(["open", "merged", "closed", "main"]);
export type SuiteHealthFixBranchState = z.infer<typeof suiteHealthFixBranchStateSchema>;

/**
 * One branch's unresolved findings. Not part of the payload - the modal does not list branches - but the prompt
 * names every one of them, so this is the shape the prompt author works over.
 */
export const suiteHealthFixBranchSchema = z.object({
    branchId: z.string(),
    branchName: z.string(),
    state: suiteHealthFixBranchStateSchema,
    prNumber: z.number().int().optional(),
    prTitle: z.string().optional(),
    prUrl: z.string().optional(),
    /** The findings shown. Capped - `issueCount` is the true total. */
    issues: z.array(suiteHealthFixIssueSchema),
    issueCount: z.number().int(),
    /** Kind tally over EVERY finding on the branch, not just the shown ones - those two routinely differ. */
    byKind: z.object({
        bug: z.number().int(),
        environment: z.number().int(),
        scenario: z.number().int(),
    }),
    /** Age of the oldest unresolved finding on this branch, in whole days. */
    oldestAgeDays: z.number().int(),
});
export type SuiteHealthFixBranch = z.infer<typeof suiteHealthFixBranchSchema>;

/**
 * A finding that shows up on more than one branch, almost always meaning ONE underlying cause. This is the whole
 * leverage of the plan: in production `homa-next` has a single scenario-setup headline on 12 branches accounting
 * for 219 of its findings, so fixing it once clears ~85% of the backlog. Telling the agent to work findings
 * one at a time would have it repair the same thing twelve times.
 *
 * Only exact repeats count, so this is silent rather than speculative when titles are genuinely distinct - which
 * is the normal case once the Reporter is authoring bespoke per-branch issue titles.
 */
export const suiteHealthFixClusterSchema = z.object({
    title: z.string(),
    kind: suiteHealthFixKindSchema,
    /** Distinct branches carrying it. */
    branches: z.number().int(),
    /** How many of those are still-open pull requests - the ones a fix unblocks today. */
    openBranches: z.number().int(),
    findings: z.number().int(),
});
export type SuiteHealthFixCluster = z.infer<typeof suiteHealthFixClusterSchema>;

/**
 * Everything the "fix it" modal needs: how much is broken, and a prompt that hands it to a coding agent holding
 * the Autonoma MCP. The objective is that one pass by the agent clears enough of the backlog to put the suite
 * back to CALIBRATING.
 *
 * The modal deliberately does NOT list the affected pull requests. The prompt names every one of them, and the
 * user is about to hand the prompt to an agent rather than work the list by hand - so rendering it twice only
 * made the dialog long enough to bury the one thing it is for.
 */
export const suiteHealthFixPlanSchema = z.object({
    /**
     * `owner/repo`, which every MCP tool is keyed by. Absent when it cannot be resolved without asking GitHub,
     * in which case the prompt tells the agent to read the git remote instead - which is what the MCP's own
     * instructions tell it to do anyway.
     */
    repoFullName: z.string().optional(),
    /** Unresolved findings across every branch. */
    totalIssues: z.number().int(),
    byKind: z.object({
        bug: z.number().int(),
        environment: z.number().int(),
        scenario: z.number().int(),
    }),
    /** Age of the oldest unresolved finding anywhere on the app, in whole days. */
    oldestAgeDays: z.number().int(),
    /** True when the scan hit its cap, so `totalIssues` is a floor rather than the count. Never hide this. */
    truncated: z.boolean(),
    /** Repeated findings, most-shared first. Empty when nothing repeats. */
    clusters: z.array(suiteHealthFixClusterSchema),
    /** The prompt the user copies. Authored from the rows above. */
    prompt: z.string(),
});
export type SuiteHealthFixPlan = z.infer<typeof suiteHealthFixPlanSchema>;
