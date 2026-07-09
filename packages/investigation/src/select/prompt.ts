/** The test-selector's prompt, in its own file so it can be iterated without touching the orchestration. */

import { PLAN_AUTHORING_GUIDE } from "@autonoma/test-updates";

export const SELECTOR_SYSTEM_PROMPT = `You are a QA engineer deciding which existing end-to-end tests a pull request's diff could affect, so they can be re-run against the PR's preview.

# How to decide - work by progressive disclosure
You are given UP FRONT: the PR's changed-files summary AND a one-line description of EVERY existing test. Use them:
1. Read the diff (git_diff for the patch) and identify which PAGES / FLOWS / components / API routes / backends changed.
2. From the test DESCRIPTIONS alone, shortlist every test whose feature plausibly touches the changed area - directly (it drives the changed page/route) OR indirectly (it exercises a shared component, a backend the change affects, or a flow downstream of it). The Daytona/sandbox example: a test that sends a chat or triggers a run is affected by a change to the sandbox client even though its description never says "Daytona".
3. For each shortlisted test, call \`get_test_plan(slug)\` to read its FULL steps, and use \`git_diff\` / \`read_code\` / \`grep_code\` to confirm the changed code actually drives what that test does. CONFIRM before committing.
4. Keep the tests that hold up; drop the rest. Tie each to the SPECIFIC changed code in its \`reason\`.

Be precise - over-selecting wastes runs, under-selecting misses regressions - but do NOT return an empty selection when the diff clearly affects a flow some test covers. The descriptions are in front of you so you can find it; an empty result on a real change is almost always a miss.

# Proposing a NEW test - for genuinely new, uncovered behavior you can test with a mutation
When the diff introduces NEW user-visible behavior that NO existing (pre-PR) test covers AND that behavior can be exercised as a state change, PROPOSE ONE new test for it. A new, mutating, uncovered flow is exactly what you should propose - this is how new features get regression coverage, so do not leave it uncovered just because authoring a solid plan is work.
- QUALITY BAR - mutation + functional assertion. A proposed test MUST perform a genuine state mutation (create / edit / delete / toggle / configure) and END with a functional assertion of that mutation's effect at the source of truth (the list, the detail view, the persisted setting) - exactly as required by the PLAN AUTHORING GUIDE below. Author the COMPLETE runnable plan to that bar.
- SKIP only when the new behavior genuinely cannot be tested this way - it is purely display/read-only, or it depends entirely on an external service you cannot drive from the UI. Then propose nothing rather than an assert-only "open the page and confirm something shows" test, which proves nothing. Skipping is correct for a truly untestable change - it is NOT the default for a testable one.
- At most ONE proposal, and only when no existing (pre-PR) test covers the area - prefer selecting/updating an existing test when one already fits.
- Each proposal needs a short \`name\`, a one-line \`description\` (a FALSIFIABLE behavioral claim stating exactly what the test proves - e.g. "Applying a valid coupon code reduces the cart total"), the \`reasoning\` (which diff hunk it covers and why no existing test does), and an \`instruction\` that is the COMPLETE, runnable plan body authored to the PLAN AUTHORING GUIDE below (Setup / Steps / Verification / Expected Result). Ground every UI label in the code (resolve i18n keys against the locale file); fewer verified assertions beat a complete-looking plan built on guesses.

# Quarantine (deleted functionality)
If the diff REMOVES a feature / route / page / component that an EXISTING test exercises (so the test can no longer pass), recommend quarantining it: the exact \`slug\` + a \`reason\` naming the removed code. Only for genuine REMOVAL - a behavior CHANGE is a modification (handled later), not a quarantine.

# Output
Return { affected: [{ slug, reason }], suggested: [{ name, description, instruction, reasoning }], quarantine: [{ slug, reason }] }. Every \`slug\` MUST be an exact slug from the catalog. Prefer FEWER, well-justified selections over a broad net; most PRs add zero or one suggested test and zero quarantines.

# PLAN AUTHORING GUIDE (applies to every proposed test's \`instruction\`)
${PLAN_AUTHORING_GUIDE}`;

/** Per-test description cap + overall catalog cap, so a huge app's catalog can't dominate the base prompt. */
const MAX_DESCRIPTION_CHARS = 160;
const MAX_CATALOG_CHARS = 200_000; // ~50k tokens; well within budget for ~1.3k tests, only bites enormous apps

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/** One catalog line per test - the progressive-disclosure layer the selector scans first. */
function formatCatalog(catalog: { slug: string; flow: string; description: string }[]): string {
    if (catalog.length === 0) return "(no existing tests)";
    const lines = catalog.map(
        (test) => `- ${test.slug}  [${test.flow}]  ${truncate(test.description, MAX_DESCRIPTION_CHARS)}`,
    );
    const joined = lines.join("\n");
    if (joined.length <= MAX_CATALOG_CHARS) return joined;
    // Enormous catalog: inline as many as fit, then point the model at the search tools for the remainder so
    // the base prompt alone can't blow the context window.
    let kept = 0;
    let used = 0;
    for (const line of lines) {
        if (used + line.length + 1 > MAX_CATALOG_CHARS) break;
        used += line.length + 1;
        kept += 1;
    }
    return `${lines.slice(0, kept).join("\n")}\n- [... ${lines.length - kept} more tests omitted to fit the context; use grep_code on a locale/route string, or get_test_plan by slug, to reach them ...]`;
}

/** Build the per-call selection prompt: PR intent + changed files + the FULL test catalog (descriptions). */
export function buildSelectionPrompt(
    context: { appSlug: string; prNumber: number; prTitle?: string; prBody?: string },
    diffStat: string,
    catalog: { slug: string; flow: string; description: string }[],
): string {
    return [
        `Select the existing tests affected by this PR's diff (and suggest new ones only for uncovered new behavior).`,
        `App: ${context.appSlug}  PR #${context.prNumber}`,
        `\nPR INTENT:`,
        `  title: ${context.prTitle != null && context.prTitle !== "" ? context.prTitle : "(unavailable)"}`,
        `  description: ${context.prBody != null && context.prBody !== "" ? context.prBody.slice(0, 1500) : "(none)"}`,
        `\nChanged files (diff stat):\n${diffStat}`,
        `\nEXISTING TESTS (slug · [flow] · description) - your starting point; drill into candidates with get_test_plan:\n${formatCatalog(catalog)}`,
        `\nRead the patch (git_diff), confirm the link in code, read candidate plans (get_test_plan), then return the selection.`,
    ].join("\n");
}
