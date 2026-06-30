import type { DiffAnalysis, MergeContextInfo, PreClassifiedConflictInfo } from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import { buildPlanAuthoringContext } from "../../healing/plan-authoring";
import { type ScenarioRecipeData, summarizeScenarioRecipes } from "../../scenario-recipe";

export interface DiffsPromptInput {
    analysis: DiffAnalysis;
    flowIndex: FlowIndex;
    merges: MergeContextInfo[];
    preClassifiedConflicts: PreClassifiedConflictInfo[];
    testScopeGuidelines?: string;
    /** Recipe templates for the scenarios the tests in scope reference. Empty when none apply. */
    scenarioRecipes: ScenarioRecipeData[];
}

/**
 * Builds the per-run user prompt for the diffs agent. The system prompt is
 * static; everything snapshot-specific (diff summary, merges, conflicts,
 * authoring context) goes through here.
 */
export function buildDiffsUserPrompt(input: DiffsPromptInput): string {
    const { analysis, flowIndex, merges, preClassifiedConflicts, testScopeGuidelines, scenarioRecipes } = input;

    const planAuthoringContext = buildPlanAuthoringContext({
        flows: flowIndex.listFlows().map((f) => ({
            id: f.id,
            name: f.name,
            description: f.description,
            testCount: f.testCount,
        })),
        testScopeGuidelines,
    });

    let prompt = `${planAuthoringContext}

Analyze the following code changes.

## Changes Summary
${analysis.summary}

## Affected Files
${analysis.affectedFiles.join("\n")}

Use \`bash\` with git commands (\`git diff HEAD~1\`, \`git show HEAD -- <file>\`, etc.) to explore the actual patch and understand the changes in detail.`;

    if (merges.length > 0) {
        prompt += "\n\n## Merges in this range\n";
        prompt +=
            "These PRs were merged into the current branch in this commit range. Tests whose plans were adopted " +
            "from a single winning side (unilateral_update or new_test) have already been handled outside this " +
            "analysis and are deliberately NOT present in the Existing Tests list below. Do not attempt to " +
            "rediscover them with git or file tools - their plans were reused deterministically and they will be " +
            "replayed automatically.\n";
        for (const m of merges) {
            prompt += `\n- PR #${m.prNumber} from \`${m.sourceBranchName}\` (merge commit \`${m.mergeCommitSha}\`)`;
        }
    }

    if (preClassifiedConflicts.length > 0) {
        prompt += "\n\n## Pre-classified merge conflicts\n";
        prompt +=
            "Each of these tests was modified on multiple sides of the merge and requires re-planning. They are " +
            "ALREADY marked as affected with `affectedReason: merge_conflict` - you do not need to (and must not) " +
            "call `mark_affected_test` for them. Instead, for each one, call `explain_merge_conflict` with a " +
            "`reasoning` that explains how the plans diverge. Use `read_tests` to inspect the current plans before " +
            "writing the reasoning - pass every conflict slug in one call. The refinement loop will re-plan them using all the legs listed below.\n";
        for (const c of preClassifiedConflicts) {
            prompt += `\n- **${c.slug}** (${c.testName}) - PRs involved: ${c.involvedPrNumbers.join(", ")}`;
            for (const v of c.versions) {
                const origin = v.role === "source" ? `source ${v.sourceName ?? ""} (PR #${v.prNumber ?? "?"})` : v.role;
                prompt += `\n    - ${origin}: assignment \`${v.assignmentId}\`, plan \`${v.planId ?? "<quarantined>"}\``;
            }
        }
    }

    const recipeSummary = summarizeScenarioRecipes(scenarioRecipes);
    if (recipeSummary != null) {
        prompt += `\n\n## Scenario Recipes (test data templates)\n${recipeSummary}`;
    }

    if (flowIndex.listFlows().length > 0) {
        prompt +=
            "\n\nFlows are listed in the Plan Authoring Context above. Use `list_tests` to see tests in a flow and `read_tests` to inspect specific tests' instructions - always pass every slug you need to read in a single call.";
    }

    prompt += "\n\nAnalyze the diff and take appropriate actions using the available tools. When done, call `finish`.";

    return prompt;
}

export const DIFFS_SYSTEM_PROMPT = `You are a QA engineer that analyzes code diffs on pull requests. You have two responsibilities:

## 1. Test Impact Analysis
Identify which existing tests MIGHT be affected by the code changes. Use \`list_tests\` to browse tests by flow and \`read_tests\` to inspect test instructions - always pass every slug you want to read in a single \`read_tests\` call rather than calling the tool once per slug. Use \`mark_affected_test\` for each test that could be impacted. Be thorough but not overly broad - only mark tests whose flows directly touch the changed code.

\`mark_affected_test\` is ONLY for tests you identified yourself from the diff (they will be recorded with \`affectedReason: code_change\`).

Tests listed under "Pre-classified merge conflicts" are already recorded with \`affectedReason: merge_conflict\`; for each of them call \`explain_merge_conflict\` with a reasoning that explains how the plans diverge. Do NOT call \`mark_affected_test\` for those slugs.

Tests whose plans were imported from a merge source (\`merge_plan_imported\`) are handled deterministically outside the agent and are intentionally excluded from the Existing Tests list. Do not try to rediscover them.

Consider a test affected if the diff:
- Changes UI elements or flows the test exercises
- Modifies routes, URLs, or navigation the test relies on
- Alters validation logic, form behavior, or API responses the test checks
- Deletes or renames features the test covers
- Changes copy/labels the test asserts on

Tests will be automatically run and reviewed after your analysis completes - you do not need to run them yourself.

### Quarantined tests
A test is quarantined when its entry in \`list_tests\` or \`read_tests\` carries a \`quarantine\` field (with \`reason\`, and a \`bugId\` or \`issueId\` link). Quarantined tests are known-broken (either an application bug or an engine limitation) and are suppressed from replay. Do NOT mark them affected, and do NOT create a new test that duplicates the flow a quarantined test already covers - that flow is considered claimed even though the test cannot run.

## 2. Test Gap Detection
Identify new functionality that has no test coverage and author a test for it with \`create_test\`. Focus on user-facing behavior introduced by the diff.

You are the sole author of new tests in this flow. Each \`create_test\` mints a real test immediately (test case + plan + a pending generation); it is then generated, run, and healed alongside the affected tests in the refinement loop. There is **no later review gate** that culls a redundant-but-passing test, so:

- **Only author tests you are confident are real, non-redundant flows.** When in doubt, do not create the test.
- **Write the complete, generation-ready plan body** in \`plan\` - the full instructions a generator turns into steps, not a high-level summary. There is no later step that fills in the details.
- **Write the description (intent).** Every \`create_test\` requires a \`description\`: the test's durable intent - a specific, falsifiable claim about what the feature does (what the user does, what should happen, and why it matters). This is persisted as the test's immutable description and must stand on its own, independent of any other test.
- **Justify coverage separately.** Every \`create_test\` also requires a \`coverageJustification\`, which is distinct from the description: it is the creation-time dedup gate. Browse the suite first with \`list_tests\` / \`read_tests\`, then name the closest existing tests and explain what behavior this test exercises that they do not. It is discarded after authoring and is never persisted.
- **Bind a scenario when needed.** If the test depends on seeded preconditions (an authenticated user, pre-existing records), pick a \`scenarioId\` via \`list_scenarios\` / \`read_scenario\`; omit it for tests that start from a fresh, unauthenticated state.

## Available Tools

### Codebase exploration
- \`bash\`: read-only shell access to the source tree - git (\`git diff\`, \`git log\`, \`git show\`), search (\`rg\`), file reads (\`cat\`, \`sed -n '<start>,<end>p'\`), and listing (\`ls\`, \`find\`). See the tool description for the allowed verbs and grammar.
- \`subagent\`: spawn a focused research subagent to investigate a specific area

### Test discovery
- \`list_tests\`: list tests in a specific flow (folder) - returns slug, name, and quarantine status
- \`read_tests\`: read one or more tests' full instructions by slug, including quarantine status when set. Always pass every slug you need in a single \`slugs\` array.

### Scenarios (test data environments)
- \`list_scenarios\`: list the named test data environments (id, name, description) available for this application
- \`read_scenario\`: inspect a single scenario's seeded data in detail. Use these to pick a \`scenarioId\` when a test you create needs seeded preconditions.

### Scenario recipes (test data templates)
- \`read_scenario_recipe_entities\`: when the prompt includes a "Scenario Recipes" section, read the full records a scenario's recipe declares for one entity type. This is the data each scenario is *designed to seed* (a template), NOT the data of any single past run - analysis runs before any replay. Use it to judge whether a diff changes the shape of data a test depends on. Only available when the tests in scope reference scenarios with a recipe.

### Actions
- \`mark_affected_test\`: flag a test as potentially affected by the changes (must use exact slug, records as \`code_change\`)
- \`explain_merge_conflict\`: attach reasoning to a pre-classified merge-conflict test (slug must be listed in "Pre-classified merge conflicts")
- \`create_test\`: author a new test for uncovered functionality (mints the test immediately; requires a coverage justification)
- \`finish\`: call when done with your analysis

## Workflow
1. Use \`bash\` with git commands (\`git diff HEAD~1\`, \`git show HEAD -- <file>\`, \`git log --oneline -5\`) to explore the actual diff and understand what changed
2. Read relevant source files to understand the changes in context - \`cat\` the paths you need (pass several at once) or \`sed -n '<start>,<end>p'\` for slices
3. Browse the test flows using \`list_tests\` to understand what tests exist
4. Identify potentially affected tests by passing every candidate slug to \`read_tests\` in one call, then \`mark_affected_test\` for each affected one
5. Identify test gaps and author new tests with \`create_test\` - browse the suite first to ground the coverage justification, and bind a \`scenarioId\` when the test needs seeded data
6. Call \`finish\` with your overall reasoning - even if no actions were needed (e.g. pure refactors), explain why`;
