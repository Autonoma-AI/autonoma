import { logger, type Logger } from "@autonoma/logger";
import { type LanguageModel, ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import type { FlowIndex } from "./flow-index";
import type { TestDirectory } from "./test-directory";
import { buildCodebaseTools, buildResolutionActionTools, buildTestInteractionTools } from "./tools/codebase-tools";
import {
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
}

export interface TestCandidateInput {
    name: string;
    instruction: string;
    url?: string;
    reasoning: string;
}

export interface ResolutionAgentInput {
    verdicts: RunReviewVerdict[];
    step1Reasoning: string;
    testCandidates: TestCandidateInput[];
}

export { type ResolutionAgentResult } from "./tools/resolution-finish-tool";

// --- Agent ---

const MAX_RETRIES = 3;

export interface ResolutionAgentConfig {
    model: LanguageModel;
    workingDirectory: string;
    flowIndex: FlowIndex;
    testDirectory: TestDirectory;
    maxSteps?: number;
}

export class ResolutionAgent {
    private readonly logger: Logger;

    constructor(private readonly config: ResolutionAgentConfig) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async resolve(input: ResolutionAgentInput): Promise<ResolutionAgentResult> {
        const prompt = buildPrompt(input);
        const failedSlugs = new Set(input.verdicts.map((v) => v.testSlug));

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const attemptResult = await this.runAgent(prompt, failedSlugs);

            const hasReasoning = attemptResult.reasoning.trim().length > 0;
            if (hasReasoning || attempt === MAX_RETRIES) return attemptResult;

            this.logger.warn("Resolution agent produced no reasoning, retrying", { attempt });
        }

        return {
            modifiedTests: [],
            quarantinedTests: [],
            reportedBugs: [],
            newTests: [],
            reasoning: `Resolution agent produced no reasoning after ${MAX_RETRIES} attempts`,
        };
    }

    private async runAgent(prompt: string, failedSlugs: Set<string>): Promise<ResolutionAgentResult> {
        const { model, workingDirectory, flowIndex, testDirectory, maxSteps = 50 } = this.config;

        let result: ResolutionAgentResult | undefined;
        const collector: ResolutionResultCollector = {
            modifiedTests: [],
            quarantinedTests: [],
            reportedBugs: [],
            newTests: [],
        };

        const agent = new ToolLoopAgent({
            model,
            instructions: SYSTEM_PROMPT,
            tools: {
                ...buildCodebaseTools(model, workingDirectory),
                ...buildTestInteractionTools(flowIndex, testDirectory),
                ...buildResolutionActionTools(collector, failedSlugs, flowIndex),
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

        await agent.generate({ messages: [{ role: "user", content: prompt }] });

        if (result == null) {
            return {
                modifiedTests: collector.modifiedTests,
                quarantinedTests: collector.quarantinedTests,
                reportedBugs: collector.reportedBugs,
                newTests: collector.newTests,
                reasoning: "",
            };
        }

        return result;
    }
}

function buildPrompt(input: ResolutionAgentInput): string {
    const { verdicts, step1Reasoning, testCandidates } = input;

    let prompt = `## Step 1 Analysis Context

The analysis agent (Step 1) reviewed the code changes and provided this reasoning:

${step1Reasoning}

## Test Replay Verdicts

The following tests were replayed after Step 1's analysis. Each test has been reviewed and given a verdict. Your job is to resolve each failure by taking the appropriate action.

`;

    for (const verdict of verdicts) {
        prompt += `### ${verdict.testName} (\`${verdict.testSlug}\`)
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

`;
        for (const candidate of testCandidates) {
            prompt += `### ${candidate.name}
- **Reasoning**: ${candidate.reasoning}
- **Instruction**: ${candidate.instruction}
`;
            if (candidate.url != null) {
                prompt += `- **URL**: ${candidate.url}\n`;
            }
            prompt += "\n";
        }
    }

    prompt += `## Instructions

You MUST handle every failed test before calling \`finish\`. For each failed test, take one of these actions:

1. **\`modify_test\`** - For \`agent_error\` verdicts where the test instruction is stale (the UI/flow changed but the test wasn't updated). Explore the codebase to understand the current state, then rewrite the instruction.

2. **\`quarantine_test\`** - For tests whose flow/feature has been completely removed from the application. The test is no longer valid and should be removed.

3. **\`report_bug\`** - For \`application_bug\` verdicts where the test is correct but found a real bug. Create a detailed bug report with codebase context.

Additionally:
- Review test candidates from Step 1 and use \`add_test\` to create the ones you agree with
- Use \`list_tests\`, \`read_test\`, and \`read_skill\` to explore existing tests and skills for context

Look for cross-cutting patterns - if multiple tests failed for the same underlying reason, explore the codebase once and apply that understanding across all affected tests.

When done, call \`finish\` with your overall reasoning.`;

    return prompt;
}

const SYSTEM_PROMPT = `You are a QA engineer resolving test failures after code changes. You receive test replay verdicts from automated reviewers and must take appropriate action for each failure.

## Your Responsibilities

1. **Resolve stale tests (agent_error)**: When a test failed because its instruction is outdated, explore the codebase to understand the current UI/flow, then rewrite the test instruction using \`modify_test\`. The new instruction must accurately describe how to test the same behavior in the updated application.

2. **Quarantine removed tests**: When a test covers functionality that has been completely removed from the application, use \`quarantine_test\` to remove it from the test suite. This is different from a stale test - the feature itself no longer exists.

3. **Report application bugs (application_bug)**: When a test correctly identified a real bug in the application, use \`report_bug\` to create a detailed report. Explore the codebase to find the root cause and suggest a fix.

4. **Create new tests**: Review test candidates suggested by Step 1. If a candidate is valid and covers important new functionality, use \`add_test\` to create it. You may also suggest new tests on your own.

5. **Identify patterns**: Look across all verdicts for common failure causes. If multiple tests failed because the same navigation flow changed, explore the flow once and apply that understanding to all affected tests.

## IMPORTANT: You MUST handle every failed test before calling \`finish\`. The finish tool will reject your call if any failed tests are unhandled. Each failed test must be addressed via \`modify_test\`, \`quarantine_test\`, or \`report_bug\`.

## Available Tools

### Codebase exploration
- \`bash\`: shell commands (git diff, git log, git show, etc.) and basic unix utilities
- \`glob\`: find files by pattern
- \`grep\`: search file contents
- \`read_file\`: read file contents
- \`subagent\`: spawn a focused research subagent to investigate a specific area

### Test discovery
- \`list_tests\`: list tests in a specific flow (folder)
- \`read_test\`: read a test's full instruction by slug
- \`read_skill\`: read a skill's full content by slug

### Actions
- \`modify_test\`: rewrite a stale test instruction (for agent_error verdicts)
- \`quarantine_test\`: remove a test whose flow no longer exists
- \`report_bug\`: report an application bug with codebase context (for application_bug verdicts)
- \`add_test\`: create a new test (from candidates or your own judgment)
- \`finish\`: call when done resolving ALL failures

## Workflow
1. Review all verdicts to identify patterns and group related failures
2. For each group, explore the codebase to understand what changed
3. Apply the appropriate action for each failure (modify_test, quarantine_test, or report_bug)
4. Review test candidates from Step 1 and create valid ones with add_test
5. Call \`finish\` with your overall reasoning - all failed tests must be handled first`;
