import { AI_REQUEST_TIMEOUT_MS, extractMessages } from "@autonoma/ai";
import { PLAN_AUTHORING_GUIDE, buildPlanAuthoringContext } from "@autonoma/healing";
import { logger, type Logger } from "@autonoma/logger";
import { type LanguageModel, ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import type { ExistingSkillInfo, ExistingTestInfo } from "./diffs-agent";
import type { FlowIndex } from "./flow-index";
import type { ScenarioIndex } from "./scenario-index";
import {
    buildCodebaseTools,
    buildResolutionActionTools,
    buildScenarioTools,
    buildTestInteractionTools,
} from "./tools/codebase-tools";
import type { AffectedReason } from "./tools/mark-affected-test-tool";
import {
    type ResolutionAgentFinishOutput,
    type ResolutionAgentResult,
    type ResolutionResultCollector,
    buildResolutionFinishTool,
} from "./tools/resolution-finish-tool";

// --- Agent input types ---

export interface RunReviewVerdict {
    runId: string;
    testSlug: string;
    testName: string;
    originalPrompt: string;
    runStatus: string;
    verdict: string;
    reviewReasoning: string;
    issueTitle?: string;
    issueConfidence?: number;
    issueDescription?: string;
    affectedReason?: AffectedReason;
}

export interface TestCandidateInput {
    candidateId: string;
    name: string;
    instruction: string;
    reasoning: string;
}

export interface ResolutionAgentInput {
    verdicts: RunReviewVerdict[];
    step1Reasoning: string;
    testCandidates: TestCandidateInput[];
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
}

export { type ResolutionAgentResult } from "./tools/resolution-finish-tool";

// --- Agent ---

const MAX_RETRIES = 3;

export interface ResolutionAgentConfig {
    model: LanguageModel;
    workingDirectory: string;
    flowIndex: FlowIndex;
    scenarioIndex: ScenarioIndex;
    maxSteps?: number;
}

export class ResolutionAgent {
    private readonly logger: Logger;

    constructor(private readonly config: ResolutionAgentConfig) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async resolve(input: ResolutionAgentInput): Promise<ResolutionAgentResult> {
        const prompt = buildPrompt(input, this.config.flowIndex, this.config.scenarioIndex);
        const failedSlugs = new Set(input.verdicts.map((v) => v.testSlug));
        const quarantinedSlugs = new Set(input.existingTests.filter((t) => t.quarantine != null).map((t) => t.slug));

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const attemptResult = await this.runAgent(
                prompt,
                failedSlugs,
                quarantinedSlugs,
                input.existingTests,
                input.existingSkills,
            );

            const hasReasoning = attemptResult.reasoning.trim().length > 0;
            if (hasReasoning || attempt === MAX_RETRIES) return attemptResult;

            this.logger.warn("Resolution agent produced no reasoning, retrying", { attempt });
        }

        return {
            modifiedTests: [],
            removedTests: [],
            reportedBugs: [],
            newTests: [],
            reasoning: `Resolution agent produced no reasoning after ${MAX_RETRIES} attempts`,
            conversation: [],
        };
    }

    private async runAgent(
        prompt: string,
        failedSlugs: Set<string>,
        quarantinedSlugs: Set<string>,
        existingTests: ExistingTestInfo[],
        existingSkills: ExistingSkillInfo[],
    ): Promise<ResolutionAgentResult> {
        const { model, workingDirectory, flowIndex, scenarioIndex, maxSteps = 50 } = this.config;

        let result: ResolutionAgentFinishOutput | undefined;
        const collector: ResolutionResultCollector = {
            modifiedTests: [],
            removedTests: [],
            reportedBugs: [],
            newTests: [],
        };

        const agent = new ToolLoopAgent({
            model,
            instructions: `${SYSTEM_PROMPT}\n\n${PLAN_AUTHORING_GUIDE}`,
            timeout: AI_REQUEST_TIMEOUT_MS,
            tools: {
                ...buildCodebaseTools(model, workingDirectory),
                ...buildTestInteractionTools(flowIndex, existingTests, existingSkills),
                ...buildScenarioTools(scenarioIndex),
                ...buildResolutionActionTools(collector, failedSlugs, quarantinedSlugs, flowIndex, scenarioIndex),
                finish: buildResolutionFinishTool(
                    (output) => {
                        result = output;
                    },
                    collector,
                    failedSlugs,
                ),
            },
            stopWhen: [stepCountIs(maxSteps), hasToolCall("finish")],
            onStepFinish: ({ content }) => {
                this.logger.info("Resolution agent step finished", {
                    text: content
                        .filter((c) => c.type === "text")
                        .map((c) => c.text)
                        .join("\n"),
                    toolCalls: content
                        .filter((c) => c.type === "tool-call")
                        .map((c) => ({
                            name: c.toolName,
                            id: c.toolCallId,
                            input: c.input,
                        })),
                    toolResults: content
                        .filter((c) => c.type === "tool-result")
                        .map((c) => ({
                            name: c.toolName,
                            id: c.toolCallId,
                            output: c.output,
                        })),
                    toolErrors: content
                        .filter((c) => c.type === "tool-error")
                        .map((c) => ({
                            name: c.toolName,
                            id: c.toolCallId,
                            error: c.error,
                        })),
                });
            },
        });

        const generateResult = await agent.generate({ messages: [{ role: "user", content: prompt }] });
        const conversation = extractMessages(generateResult);

        if (result == null) {
            return {
                modifiedTests: collector.modifiedTests,
                removedTests: collector.removedTests,
                reportedBugs: collector.reportedBugs,
                newTests: collector.newTests,
                reasoning: "",
                conversation,
            };
        }

        return { ...result, conversation };
    }
}

function buildPrompt(input: ResolutionAgentInput, flowIndex: FlowIndex, scenarioIndex: ScenarioIndex): string {
    const { verdicts, step1Reasoning, testCandidates, existingSkills } = input;

    const planAuthoringContext = buildPlanAuthoringContext({
        scenarios: scenarioIndex.listScenarios().map((s) => ({ id: s.id, name: s.name, description: s.description })),
        skills: existingSkills.map((s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description })),
        flows: flowIndex.listFlows().map((f) => ({
            id: f.id,
            name: f.name,
            description: f.description,
            testCount: f.testCount,
        })),
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
            prompt += `- **Issue**: ${verdict.issueTitle}`;
            if (verdict.issueConfidence != null) {
                prompt += ` (confidence: ${verdict.issueConfidence}%)`;
            }
            prompt += "\n";
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
- Use \`list_tests\`, \`read_test\`, and \`read_skill\` to explore existing tests and skills for context

Look for cross-cutting patterns - if multiple tests failed for the same underlying reason, explore the codebase once and apply that understanding across all affected tests.

When done, call \`finish\` with your overall reasoning.`;
    } else {
        prompt += `## Instructions

There are no test replay failures to resolve. Your job is to review the test candidates suggested by Step 1 and create the ones you agree with using \`add_test\`.

- Use \`list_tests\`, \`read_test\`, and \`read_skill\` to explore existing tests and skills and avoid duplicating coverage.
- Do not invent failures or call \`modify_test\`, \`remove_test\`, or \`report_bug\` - there are no failed tests in this run.

When done, call \`finish\` with your overall reasoning.`;
    }

    return prompt;
}

const SYSTEM_PROMPT = `You are a QA engineer resolving test failures after code changes. You receive test replay verdicts from automated reviewers and must take appropriate action for each failure.

## Your Responsibilities

1. **Resolve stale tests (agent_error)**: When a test failed because its instruction is outdated, explore the codebase to understand the current UI/flow, then rewrite the test instruction using \`modify_test\`. The new instruction must accurately describe how to test the same behavior in the updated application.

2. **Remove obsolete tests**: When a test covers functionality that has been completely removed from the application, use \`remove_test\` to take it out of the suite. This is different from a stale test - the feature itself no longer exists.

3. **Report application bugs (application_bug)**: When a test correctly identified a real bug in the application, use \`report_bug\` to create a detailed report. Explore the codebase to find the root cause and suggest a fix.

4. **Create new tests**: Review test candidates suggested by Step 1. If a candidate is valid and covers important new functionality, use \`add_test\` to create it. You may also suggest new tests on your own.

5. **Identify patterns**: Look across all verdicts for common failure causes. If multiple tests failed because the same navigation flow changed, explore the flow once and apply that understanding to all affected tests.

## IMPORTANT: You MUST handle every failed test before calling \`finish\`. The finish tool will reject your call if any failed tests are unhandled. Each failed test must be addressed via \`modify_test\`, \`remove_test\`, or \`report_bug\`.

## Quarantined tests
A test is quarantined when its entry in \`list_tests\` or \`read_test\` carries a \`quarantine\` field (with \`reason\`, and a \`bugId\` or \`issueId\` link). Quarantined tests were excluded from replay so they will not appear among the failed verdicts. Treat each one as still owning coverage of its flow: do NOT propose a new test that duplicates that coverage, and do NOT call \`modify_test\` on a quarantined slug. There is no tool to clear a quarantine - that happens via manual review.

## Available Tools

### Codebase exploration
- \`bash\`: shell commands (git diff, git log, git show, etc.) and basic unix utilities
- \`glob\`: find files by pattern
- \`grep\`: search file contents
- \`read_file\`: read file contents
- \`subagent\`: spawn a focused research subagent to investigate a specific area

### Test discovery
- \`list_tests\`: list tests in a specific flow (folder); each entry includes quarantine status
- \`read_test\`: read a test's full instruction by slug, including quarantine status when set
- \`read_skill\`: read a skill's full content by slug

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
