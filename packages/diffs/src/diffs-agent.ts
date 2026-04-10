import { logger, type Logger } from "@autonoma/logger";
import { type LanguageModel, ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import type { DiffsAgentCallbacks } from "./callbacks";
import { buildActionTools, buildCodebaseTools } from "./tools/codebase-tools";
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
    analysis: DiffAnalysis;
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
}

export interface TestRunResult {
    slug: string;
    testName: string;
    success: boolean;
    finishReason: "success" | "max_steps" | "error";
    reasoning?: string;
    stepDescriptions: string[];
    videoUrl?: string;
    screenshotUrls: string[];
}

// --- Agent ---

const MAX_RETRIES = 3;

export interface DiffsAgentConfig {
    model: LanguageModel;
    workingDirectory: string;
    callbacks: DiffsAgentCallbacks;
    maxSteps?: number;
}

export class NoAgentOutputError extends Error {
    constructor() {
        super("Agent produced no output");
    }
}

export class DiffsAgent {
    private readonly logger: Logger;

    constructor(private readonly config: DiffsAgentConfig) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async analyze(input: DiffsAgentInput): Promise<DiffsAgentResult> {
        const prompt = buildPrompt(input);
        const validSlugs = new Set(input.existingTests.map((t) => t.slug));

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const attemptResult = await this.runAgent(prompt, validSlugs);

            const hasActions =
                attemptResult.testActions.length > 0 ||
                attemptResult.bugReports.length > 0 ||
                attemptResult.skillUpdates.length > 0 ||
                attemptResult.newTests.length > 0;

            if (hasActions || attempt === MAX_RETRIES) return attemptResult;
        }

        return {
            skillUpdates: [],
            testActions: [],
            bugReports: [],
            newTests: [],
            reasoning: `Agent produced no results after ${MAX_RETRIES} attempts`,
        };
    }

    private async runAgent(prompt: string, validSlugs: Set<string>): Promise<DiffsAgentResult> {
        const completedRuns = new Set<string>();

        const { model, workingDirectory, maxSteps = 50 } = this.config;

        let result: DiffsAgentResult | undefined;
        const collector: ResultCollector = {
            skillUpdates: [],
            testActions: [],
            bugReports: [],
            newTests: [],
        };

        const agent = new ToolLoopAgent({
            model,
            instructions: SYSTEM_PROMPT,
            tools: {
                ...buildCodebaseTools(model, workingDirectory),
                ...buildActionTools(this.config.callbacks, completedRuns, collector, validSlugs),
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
                skillUpdates: collector.skillUpdates,
                testActions: collector.testActions,
                bugReports: collector.bugReports,
                newTests: collector.newTests,
                reasoning: "Agent did not call finish",
            };
        }

        return result;
    }
}

function buildPrompt(input: DiffsAgentInput): string {
    const { analysis, existingTests, existingSkills } = input;

    let prompt = `Analyze the following code changes.

## Changes Summary
${analysis.summary}

## Affected Files
${analysis.affectedFiles.join("\n")}

Use \`bash\` with git commands (\`git diff HEAD~1\`, \`git show HEAD -- <file>\`, etc.) to explore the actual patch and understand the changes in detail.`;

    if (existingSkills.length > 0) {
        prompt += "\n\n## Existing Skills\n";
        prompt += "IMPORTANT: Use the `id` field as the `skillId` when calling `update_skill`.\n";
        for (const skill of existingSkills) {
            prompt += `\n### ${skill.name}\n`;
            prompt += `- **id**: \`${skill.id}\` (use this as skillId in tools)\n`;
            prompt += `- **slug**: ${skill.slug}\n`;
            prompt += `- **description**: ${skill.description}\n`;
            prompt += `- **content**:\n\`\`\`\n${skill.content}\n\`\`\`\n`;
        }
    }

    if (existingTests.length > 0) {
        prompt += "\n\n## Existing Tests\n";
        prompt +=
            "IMPORTANT: When calling tools that require a slug (`run_test`, `modify_test`, `quarantine_test`, `bug_found`), " +
            "you MUST use the EXACT `slug` values listed below. Slugs are plain identifiers like `login-flow` or " +
            "`checkout-page-validation` - NOT file paths and NOT filenames. Do NOT derive slugs from the filesystem. " +
            "Do NOT append `.md` or any file extension. Only use slugs that appear in this list.\n";
        for (const test of existingTests) {
            prompt += `\n### ${test.name}\n`;
            prompt += `- **slug**: \`${test.slug}\` (use this as the slug in tools)\n`;
            prompt += `- **instruction**: ${test.prompt}\n`;
        }
    }

    prompt += "\n\nAnalyze the diff and take appropriate actions using the available tools. When done, call `finish`.";

    return prompt;
}

const SYSTEM_PROMPT = `You are a QA engineer that analyzes code diffs on pull requests. You have three responsibilities:

## 1. Skill Update Detection
Skills are reusable sub-flows (e.g. "login", "checkout") used by tests. Check if any existing skills need updating because the code they describe has changed. Use \`update_skill\` for any skill whose content is now outdated.

## 2. Test Impact Analysis
Identify which existing tests MIGHT be affected by the code changes. For potentially affected tests:
1. Run them using \`run_test\` to see if they still pass
2. Based on the execution results, take ONE of these actions PER test:
   - \`quarantine_test\` - ONLY if the entire flow the test covers was deleted from the codebase, making the test permanently obsolete with no equivalent flow to test. This is rare - use it only when the feature is completely gone, not when it was replaced or restructured.
   - \`bug_found\` - if the test failed due to a bug INTRODUCED by the PR (e.g. a new validation regex that rejects valid input, broken logic added by this PR). Do NOT report pre-existing issues or code quality concerns that existed before the PR.
   - \`modify_test\` - if the test broke because the UI/flow changed (not a bug, the test needs updating). This includes cases where a feature was replaced with a different implementation (e.g. pagination replaced with infinite scroll) - the test should be rewritten to cover the new equivalent flow.
   - Do nothing if the test still passes

CRITICAL: You MUST run a test with \`run_test\` BEFORE using quarantine_test, bug_found, or modify_test on it. These tools will reject calls for tests that haven't been run.

## 3. Test Gap Detection
Identify new functionality that has no test coverage. Use \`add_test\` for each new test that should be created.

## Available Tools

### Codebase exploration
- \`bash\`: shell commands (git diff, git log, git show, etc.) and basic unix utilities
- \`glob\`: find files by pattern
- \`grep\`: search file contents
- \`read_file\`: read file contents
- \`subagent\`: spawn a focused research subagent to investigate a specific area

### Actions
- \`run_test\`: trigger one or more tests in parallel by passing an array of slugs (unlocks post-run tools for those tests)
- \`quarantine_test\`: quarantine a test whose flow was deleted (requires run_test first)
- \`bug_found\`: report a bug with detailed explanation and fix prompt (requires run_test first)
- \`modify_test\`: update a test instruction to match new behavior (requires run_test first)
- \`update_skill\`: update a skill's content
- \`add_test\`: suggest a new test for uncovered functionality
- \`finish\`: call when done with your analysis

## File System Layout
Test files exist on disk at \`autonoma/qa-tests/{slug}.md\` and skills at \`autonoma/skills/{slug}.md\`. These files are for reference only - you can read them to understand test content. When calling tools, always use the plain slug identifiers from the Existing Tests section (e.g. \`login-flow\`), never file paths or filenames with extensions.

## Workflow
1. Use \`bash\` with git commands (\`git diff HEAD~1\`, \`git show HEAD -- <file>\`, \`git log --oneline -5\`) to explore the actual diff and understand what changed
2. Read relevant source files to understand the changes in context
3. Check if any skills need updating (use subagents to parallelize)
4. Identify potentially affected tests and batch them into a single \`run_test\` call for parallel execution
5. Take appropriate post-run actions based on results
6. Identify test gaps and add new test suggestions
7. Call \`finish\` with your overall reasoning`;
