import { logger, type Logger } from "@autonoma/logger";
import { type LanguageModel, ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import { buildDiffAnalysis } from "./diff-analysis";
import type { FlowIndex } from "./flow-index";
import type { TestDirectory } from "./test-directory";
import { buildActionTools, buildCodebaseTools, buildTestInteractionTools } from "./tools/codebase-tools";
import { type DiffsAgentResult, type ResultCollector, buildFinishTool } from "./tools/finish-tool";

// --- Agent input types ---

export interface DiffAnalysis {
    affectedFiles: string[];
    summary: string;
}

export interface ExistingTestInfo {
    id: string;
    name: string;
    slug: string;
    prompt: string;
}

export interface ExistingSkillInfo {
    id: string;
    name: string;
    slug: string;
    description: string;
    content: string;
}

export interface DiffsAgentInput {
    headSha: string;
    baseSha: string;
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
}

// --- Agent ---

const MAX_RETRIES = 3;

export interface DiffsAgentConfig {
    model: LanguageModel;
    workingDirectory: string;
    flowIndex: FlowIndex;
    testDirectory: TestDirectory;
    maxSteps?: number;
}

export class DiffsAgent {
    private readonly logger: Logger;

    constructor(private readonly config: DiffsAgentConfig) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async analyze(input: DiffsAgentInput): Promise<DiffsAgentResult> {
        const analysis = await buildDiffAnalysis(
            this.config.workingDirectory,
            input.headSha,
            input.baseSha,
            this.logger,
        );
        const prompt = buildPrompt(
            { analysis, existingTests: input.existingTests, existingSkills: input.existingSkills },
            this.config.flowIndex,
        );
        const validSlugs = new Set(input.existingTests.map((t) => t.slug));

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const attemptResult = await this.runAgent(prompt, validSlugs);

            const hasReasoning = attemptResult.reasoning.trim().length > 0;
            if (hasReasoning || attempt === MAX_RETRIES) return attemptResult;

            this.logger.warn("Agent produced no reasoning, retrying", { attempt });
        }

        return {
            affectedTests: [],
            testCandidates: [],
            reasoning: `Agent produced no reasoning after ${MAX_RETRIES} attempts`,
        };
    }

    private async runAgent(prompt: string, validSlugs: Set<string>): Promise<DiffsAgentResult> {
        const { model, workingDirectory, flowIndex, testDirectory, maxSteps = 50 } = this.config;

        let result: DiffsAgentResult | undefined;
        const collector: ResultCollector = {
            affectedTests: [],
            testCandidates: [],
        };

        const agent = new ToolLoopAgent({
            model,
            instructions: SYSTEM_PROMPT,
            tools: {
                ...buildCodebaseTools(model, workingDirectory),
                ...buildTestInteractionTools(flowIndex, testDirectory),
                ...buildActionTools(collector, validSlugs),
                finish: buildFinishTool((output) => {
                    result = output;
                }, collector),
            },
            stopWhen: [stepCountIs(maxSteps), hasToolCall("finish")],
            onStepFinish: ({ content }) => {
                this.logger.info("Agent step finished", {
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
                affectedTests: collector.affectedTests,
                testCandidates: collector.testCandidates,
                reasoning: "",
            };
        }

        return result;
    }
}

interface PromptInput {
    analysis: DiffAnalysis;
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
}

function buildPrompt(input: PromptInput, flowIndex: FlowIndex): string {
    const { analysis } = input;

    let prompt = `Analyze the following code changes.

## Changes Summary
${analysis.summary}

## Affected Files
${analysis.affectedFiles.join("\n")}

Use \`bash\` with git commands (\`git diff HEAD~1\`, \`git show HEAD -- <file>\`, etc.) to explore the actual patch and understand the changes in detail.`;

    // Show flows (folders) as navigable context
    const flows = flowIndex.listFlows();
    if (flows.length > 0) {
        prompt += "\n\n## Test Flows\n";
        prompt +=
            "Tests are organized into flows (folders). Use `list_tests` to see tests in a flow, " +
            "and `read_test` to inspect a specific test's instruction.\n";
        for (const flow of flows) {
            prompt += `\n- **${flow.name}** (${flow.testCount} tests)`;
            if (flow.description != null) {
                prompt += ` - ${flow.description}`;
            }
        }
    }

    prompt += "\n\nAnalyze the diff and take appropriate actions using the available tools. When done, call `finish`.";

    return prompt;
}

const SYSTEM_PROMPT = `You are a QA engineer that analyzes code diffs on pull requests. You have two responsibilities:

## 1. Test Impact Analysis
Identify which existing tests MIGHT be affected by the code changes. Use \`list_tests\` to browse tests by flow and \`read_test\` to inspect test instructions. Use \`mark_affected_test\` for each test that could be impacted. Be thorough but not overly broad - only mark tests whose flows directly touch the changed code.

Consider a test affected if the diff:
- Changes UI elements or flows the test exercises
- Modifies routes, URLs, or navigation the test relies on
- Alters validation logic, form behavior, or API responses the test checks
- Deletes or renames features the test covers
- Changes copy/labels the test asserts on

Tests will be automatically run and reviewed after your analysis completes - you do not need to run them yourself.

## 2. Test Gap Detection
Identify new functionality that has no test coverage. Use \`suggest_test\` for each new test that should be created. Focus on user-facing behavior introduced by the diff. These suggestions will be reviewed in a later step.

## Available Tools

### Codebase exploration
- \`bash\`: shell commands (git diff, git log, git show, etc.) and basic unix utilities
- \`glob\`: find files by pattern
- \`grep\`: search file contents
- \`read_file\`: read file contents
- \`subagent\`: spawn a focused research subagent to investigate a specific area

### Test discovery
- \`list_tests\`: list tests in a specific flow (folder) - returns slugs and names
- \`read_test\`: read a test's full instruction by slug
- \`read_skill\`: read a skill's full content by slug

### Actions
- \`mark_affected_test\`: flag a test as potentially affected by the changes (must use exact slug)
- \`suggest_test\`: suggest a new test for uncovered functionality
- \`finish\`: call when done with your analysis

## File System Layout
Test files exist on disk at \`autonoma/qa-tests/{slug}.md\` and skills at \`autonoma/skills/{slug}.md\`. These files are for reference only - prefer using \`read_test\` and \`read_skill\` tools to inspect them. When calling tools, always use plain slug identifiers (e.g. \`login-flow\`), never file paths.

## Workflow
1. Use \`bash\` with git commands (\`git diff HEAD~1\`, \`git show HEAD -- <file>\`, \`git log --oneline -5\`) to explore the actual diff and understand what changed
2. Read relevant source files to understand the changes in context
3. Browse the test flows using \`list_tests\` to understand what tests exist
4. Identify potentially affected tests using \`read_test\` to check instructions, then \`mark_affected_test\` for each affected one
5. Identify test gaps and suggest new tests with \`suggest_test\`
6. Call \`finish\` with your overall reasoning - even if no actions were needed (e.g. pure refactors), explain why`;
