import type { PreviewBuildWarrantReason } from "../activities";

/** Pure by contract: keep Temporal out, or the rules stop being assertable without a test server. */

/** PR numbers start at 1, so 0 is the main branch's stable non-PR environment. */
const MAIN_BRANCH_ENVIRONMENT_NUMBER = 0;

/**
 * The reasons that refuse a build.
 *
 * `analysis_indeterminate` sits here because the warrant fails closed: an analysis that threw cannot say the
 * commit deserved a preview, so it does not get one and the next push re-judges on its own diff.
 */
const REFUSING_REASONS: ReadonlySet<PreviewBuildWarrantReason> = new Set(["no_test_work", "analysis_indeterminate"]);

/** Whether a commit with this reason gets a preview build. */
export function warrantsBuild(reason: PreviewBuildWarrantReason): boolean {
    return !REFUSING_REASONS.has(reason);
}

/**
 * Why this commit is warranted a build whatever impact analysis finds, or undefined when the selection decides.
 *
 * Both exemptions exist because refusing would take away something the customer already has: main has no pull
 * request whose diff could be judged, and a branch whose preview URL has been seen keeps refreshing it.
 */
export function unconditionalWarrant(facts: {
    prNumber: number;
    everPreviewed: boolean;
}): PreviewBuildWarrantReason | undefined {
    if (facts.prNumber <= MAIN_BRANCH_ENVIRONMENT_NUMBER) return "main_branch_preview";
    return facts.everPreviewed ? "branch_already_previewed" : undefined;
}

/** What the selection decides on a branch whose warrant depends on it: work to do means an environment to do it in. */
export function warrantFromSelection(selected: number): PreviewBuildWarrantReason {
    return selected === 0 ? "no_test_work" : "analysis_selected_tests";
}

/**
 * A head already analyzed, where re-judging is impossible. Whether a build was ever attempted is a fact, so it is
 * what decides - no attempt means the commit was found unwarranted, and rebuilding would overturn that on every
 * redelivered webhook.
 */
export function warrantForJudgedHead(priorBuildAttempted: boolean): PreviewBuildWarrantReason {
    return priorBuildAttempted ? "head_already_analyzed" : "no_test_work";
}
