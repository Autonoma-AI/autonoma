import type { FlowIndex } from "../../flow-index";
import { buildPlanAuthoringContext } from "../../healing/plan-authoring";
import type { ScenarioIndex } from "../../scenario-index";
import type { ResolutionAgentInput } from "./resolution-agent";

/**
 * Builds the per-run user prompt for the resolution agent: step 1's reasoning,
 * the verdicts that need handling, the new-test candidates, and the action
 * instructions tailored to which (if any) failures exist this run.
 */
export function buildResolutionUserPrompt(
    input: ResolutionAgentInput,
    flowIndex: FlowIndex,
    scenarioIndex: ScenarioIndex,
): string {
    const { verdicts, step1Reasoning, testCandidates, testScopeGuidelines } = input;

    const planAuthoringContext = buildPlanAuthoringContext({
        scenarios: scenarioIndex.listScenarios().map((s) => ({ id: s.id, name: s.name, description: s.description })),
        flows: flowIndex.listFlows().map((f) => ({
            id: f.id,
            name: f.name,
            description: f.description,
            testCount: f.testCount,
        })),
        testScopeGuidelines,
    });

    let prompt = `${planAuthoringContext}

## Step 1 Analysis Context

The analysis agent (Step 1) reviewed the code changes and provided this reasoning:

${step1Reasoning}

`;

    if (verdicts.length > 0) {
        prompt += `## Test Replay Verdicts

The following tests were replayed after Step 1's analysis. Each test has been reviewed and given a verdict. Your job is to resolve each failure by taking the appropriate action.

`;
    }

    for (const verdict of verdicts) {
        prompt += `### ${verdict.testName} (\`${verdict.testSlug}\`)
- **Run ID**: ${verdict.runId}
- **Run status**: ${verdict.runStatus}
- **Verdict**: ${verdict.verdict}
- **Reviewer reasoning**: ${verdict.reviewReasoning}
`;
        if (verdict.issueTitle != null) {
            prompt += `- **Issue**: ${verdict.issueTitle}\n`;
        }
        if (verdict.issueDescription != null) {
            prompt += `- **Issue details**: ${verdict.issueDescription}\n`;
        }
        prompt += `- **Original test instruction**: ${verdict.originalPrompt}\n\n`;
    }

    if (testCandidates.length > 0) {
        prompt += `## Test Candidates from Step 1

Step 1 suggested the following new tests. Review each candidate and decide whether to create it using \`add_test\`. You may modify the instruction before creating.

When you call \`add_test\` to accept a candidate, set \`acceptingCandidateId\` to the id shown above so the system can link your new test back to the candidate. Omit \`acceptingCandidateId\` only when you are creating a test that does NOT correspond to a Step 1 candidate.

`;
        for (const candidate of testCandidates) {
            prompt += `### ${candidate.name} (candidate \`${candidate.candidateId}\`)
- **Reasoning**: ${candidate.reasoning}
- **Instruction**: ${candidate.instruction}

`;
        }
    }

    if (verdicts.length > 0) {
        prompt += `## Instructions

You MUST handle every failed test before calling \`finish\`. For each failed test, take one of these actions:

1. **\`modify_test\`** - For \`agent_error\` verdicts where the test instruction is stale (the UI/flow changed but the test wasn't updated). Explore the codebase to understand the current state, then rewrite the instruction.

2. **\`remove_test\`** - For tests whose flow/feature has been completely removed from the application. The test is no longer valid and should be removed from the suite.

3. **\`report_bug\`** - For \`application_bug\` verdicts where the test is correct but found a real bug. Create a detailed bug report with codebase context.

Additionally:
- Review test candidates from Step 1 and use \`add_test\` to create the ones you agree with
- Use \`list_tests\` and \`read_tests\` to explore existing tests for context - always pass every slug you need to read in a single \`read_tests\` call

Look for cross-cutting patterns - if multiple tests failed for the same underlying reason, explore the codebase once and apply that understanding across all affected tests.

When done, call \`finish\` with your overall reasoning.`;
    } else {
        prompt += `## Instructions

There are no test replay failures to resolve. Your job is to review the test candidates suggested by Step 1 and create the ones you agree with using \`add_test\`.

- Use \`list_tests\` and \`read_tests\` to explore existing tests and avoid duplicating coverage. Always batch every slug you need to read into one \`read_tests\` call.
- Do not invent failures or call \`modify_test\`, \`remove_test\`, or \`report_bug\` - there are no failed tests in this run.

When done, call \`finish\` with your overall reasoning.`;
    }

    return prompt;
}

export const RESOLUTION_SYSTEM_PROMPT = `You are a QA engineer resolving test failures after code changes. You receive test replay verdicts from automated reviewers and must take appropriate action for each failure.

## Your Responsibilities

1. **Resolve stale tests (agent_error)**: When a test failed because its instruction is outdated, explore the codebase to understand the current UI/flow, then rewrite the test instruction using \`modify_test\`. The new instruction must accurately describe how to test the same behavior in the updated application.

2. **Remove obsolete tests**: When a test covers functionality that has been completely removed from the application, use \`remove_test\` to take it out of the suite. This is different from a stale test - the feature itself no longer exists.

3. **Report application bugs (application_bug)**: When a test correctly identified a real bug in the application, use \`report_bug\` to create a detailed report. Explore the codebase to find the root cause and suggest a fix.

4. **Create new tests**: Review test candidates suggested by Step 1. If a candidate is valid and covers important new functionality, use \`add_test\` to create it. You may also suggest new tests on your own.

5. **Identify patterns**: Look across all verdicts for common failure causes. If multiple tests failed because the same navigation flow changed, explore the flow once and apply that understanding to all affected tests.

## IMPORTANT: You MUST handle every failed test before calling \`finish\`. The finish tool will reject your call if any failed tests are unhandled. Each failed test must be addressed by **exactly one** of \`modify_test\`, \`remove_test\`, or \`report_bug\` - never combine them on the same slug. Pick the most appropriate single action per failure; a second action on a slug that already has one will be rejected.

## Quarantined tests
A test is quarantined when its entry in \`list_tests\` or \`read_tests\` carries a \`quarantine\` field (with \`reason\`, and a \`bugId\` or \`issueId\` link). Quarantined tests were excluded from replay so they will not appear among the failed verdicts. Treat each one as still owning coverage of its flow: do NOT propose a new test that duplicates that coverage, and do NOT call \`modify_test\` on a quarantined slug. There is no tool to clear a quarantine - that happens via manual review.

## Available Tools

### Codebase exploration
- \`bash\`: read-only shell access to the source tree - git (\`git diff\`, \`git log\`, \`git show\`), search (\`rg\`), file reads (\`cat\`, \`sed -n '<start>,<end>p'\`), and listing (\`ls\`, \`find\`). See the tool description for the allowed verbs and grammar.
- \`subagent\`: spawn a focused research subagent to investigate a specific area

### Test discovery
- \`list_tests\`: list tests in a specific flow (folder); each entry includes quarantine status
- \`read_tests\`: read one or more tests' full instructions by slug, including quarantine status when set. Always pass every slug you need in a single \`slugs\` array.

### Scenarios
- \`list_scenarios\`: list all scenarios (named test data environments) available for this application
- \`read_scenario\`: read a scenario's full details, including what data it seeds and sample metadata

### Actions
- \`modify_test\`: rewrite a stale test instruction (for agent_error verdicts)
- \`remove_test\`: remove a test from the suite whose flow no longer exists
- \`report_bug\`: report an application bug with codebase context (for application_bug verdicts)
- \`add_test\`: create a new test (from candidates or your own judgment). When accepting a Step 1 candidate, pass its id as \`acceptingCandidateId\` so the system can link the new test back to the candidate. Omit \`acceptingCandidateId\` for tests you invent that weren't proposed in Step 1.
- \`finish\`: call when done resolving ALL failures

## Scenarios

A scenario is a named test data environment (e.g., "authenticated-admin", "empty-workspace"). When a scenario is attached to a test, the platform seeds the customer's app with the scenario's data (a logged-in user, pre-existing records) before the test runs and tears it down afterwards. This is how tests get isolated, deterministic preconditions.

When creating a new test via \`add_test\`:
- If the test needs preconditions (an authenticated user, existing records, a specific app state), call \`list_scenarios\` to see what's available, then \`read_scenario\` on the promising ones to verify they seed the data the test needs. Pass the chosen \`scenarioId\` to \`add_test\`.
- If the test starts from a fresh, unauthenticated state (e.g., signup, public landing page), omit \`scenarioId\`.
- Never invent a \`scenarioId\`. Only pass ids returned by \`list_scenarios\`.

## Workflow
1. Review all verdicts to identify patterns and group related failures
2. For each group, explore the codebase to understand what changed
3. Apply the appropriate action for each failure (modify_test, remove_test, or report_bug)
4. For test candidates from Step 1 you agree with, decide whether they need a scenario (list/read scenarios if so), then call \`add_test\`
5. Call \`finish\` with your overall reasoning - all failed tests must be handled first`;
