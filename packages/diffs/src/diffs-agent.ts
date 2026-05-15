import { AI_REQUEST_TIMEOUT_MS, extractMessages } from "@autonoma/ai";
import { logger, type Logger } from "@autonoma/logger";
import { type LanguageModel, ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import { buildDiffAnalysis } from "./diff-analysis";
import type { FlowIndex } from "./flow-index";
import { buildActionTools, buildCodebaseTools, buildTestInteractionTools } from "./tools/codebase-tools";
import {
    type DiffsAgentFinishOutput,
    type DiffsAgentResult,
    type ResultCollector,
    buildFinishTool,
} from "./tools/finish-tool";

// --- Agent input types ---

export interface DiffAnalysis {
    affectedFiles: string[];
    summary: string;
}

/** Quarantine metadata for a single test case in a single snapshot. */
export interface QuarantineInfo {
    reason: "application_bug" | "engine_limitation";
    bugId?: string;
    issueId?: string;
}

export interface ExistingTestInfo {
    id: string;
    name: string;
    slug: string;
    prompt: string;
    quarantine?: QuarantineInfo;
}

export interface ExistingSkillInfo {
    id: string;
    name: string;
    slug: string;
    description: string;
    content: string;
}

export interface MergeContextInfo {
    prNumber: number;
    sourceBranchName: string;
    sourceSnapshotId: string;
    mergeCommitSha: string;
}

export interface PreClassifiedConflictVersion {
    /** Where this leg came from: main's current state, main's state when the source last synced, or one of the source branches. */
    role: "target-current" | "target-base" | "source";
    sourceName?: string;
    prNumber?: number;
    assignmentId: string;
    planId: string | null;
}

/**
 * A test that was deterministically classified as a merge conflict before the
 * agent ran. The agent receives these pre-marked as affected with
 * `affectedReason: "merge_conflict"` and only fills in the reasoning via the
 * `explain_merge_conflict` tool, using the provided legs for context. Tests
 * handled outside the agent (unilateral_update / new_test) are dispatched to
 * replay directly with `merge_plan_imported` and are intentionally not
 * included in `existingTests` for the agent-visible list.
 */
export interface PreClassifiedConflictInfo {
    slug: string;
    testName: string;
    versions: PreClassifiedConflictVersion[];
    involvedPrNumbers: number[];
}

export interface DiffsAgentInput {
    headSha: string;
    baseSha: string;
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
    /** Merges present in the range that were deterministically processed before the agent ran. Empty for non-merge runs. */
    merges?: MergeContextInfo[];
    /** Merge-conflict tests to enrich with reasoning. Empty for non-merge runs. */
    preClassifiedConflicts?: PreClassifiedConflictInfo[];
}

// --- Agent ---

const MAX_RETRIES = 3;

export interface DiffsAgentConfig {
    model: LanguageModel;
    workingDirectory: string;
    flowIndex: FlowIndex;
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
            {
                analysis,
                existingTests: input.existingTests,
                existingSkills: input.existingSkills,
                merges: input.merges ?? [],
                preClassifiedConflicts: input.preClassifiedConflicts ?? [],
            },
            this.config.flowIndex,
        );
        const validSlugs = new Set(input.existingTests.map((t) => t.slug));
        const quarantinedSlugs = new Set(input.existingTests.filter((t) => t.quarantine != null).map((t) => t.slug));
        const preClassifiedConflicts = input.preClassifiedConflicts ?? [];

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const attemptResult = await this.runAgent(
                prompt,
                validSlugs,
                quarantinedSlugs,
                preClassifiedConflicts,
                input.existingTests,
                input.existingSkills,
            );

            const hasReasoning = attemptResult.reasoning.trim().length > 0;
            if (hasReasoning || attempt === MAX_RETRIES) return attemptResult;

            this.logger.warn("Agent produced no reasoning, retrying", { attempt });
        }

        return {
            affectedTests: [],
            testCandidates: [],
            reasoning: `Agent produced no reasoning after ${MAX_RETRIES} attempts`,
            conversation: [],
        };
    }

    private async runAgent(
        prompt: string,
        validSlugs: Set<string>,
        quarantinedSlugs: Set<string>,
        preClassifiedConflicts: PreClassifiedConflictInfo[],
        existingTests: ExistingTestInfo[],
        existingSkills: ExistingSkillInfo[],
    ): Promise<DiffsAgentResult> {
        const { model, workingDirectory, flowIndex, maxSteps = 50 } = this.config;

        let result: DiffsAgentFinishOutput | undefined;
        const collector: ResultCollector = {
            affectedTests: preClassifiedConflicts.map((c) => ({
                slug: c.slug,
                testName: c.testName,
                affectedReason: "merge_conflict" as const,
                reasoning: "",
            })),
            testCandidates: [],
        };
        const validConflictSlugs = new Set(preClassifiedConflicts.map((c) => c.slug));

        const agent = new ToolLoopAgent({
            model,
            instructions: SYSTEM_PROMPT,
            timeout: AI_REQUEST_TIMEOUT_MS,
            tools: {
                ...buildCodebaseTools(model, workingDirectory),
                ...buildTestInteractionTools(flowIndex, existingTests, existingSkills),
                ...buildActionTools(collector, validSlugs, validConflictSlugs, quarantinedSlugs),
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

        const generateResult = await agent.generate({ messages: [{ role: "user", content: prompt }] });
        const conversation = extractMessages(generateResult);

        if (result == null) {
            return {
                affectedTests: collector.affectedTests,
                testCandidates: collector.testCandidates,
                reasoning: "",
                conversation,
            };
        }

        return { ...result, conversation };
    }
}

interface PromptInput {
    analysis: DiffAnalysis;
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
    merges: MergeContextInfo[];
    preClassifiedConflicts: PreClassifiedConflictInfo[];
}

function buildPrompt(input: PromptInput, flowIndex: FlowIndex): string {
    const { analysis, merges, preClassifiedConflicts } = input;

    let prompt = `Analyze the following code changes.

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
            "`reasoning` that explains how the plans diverge. Use `read_test` to inspect the current plan before " +
            "writing the reasoning. The Resolution step will re-plan them using all the legs listed below.\n";
        for (const c of preClassifiedConflicts) {
            prompt += `\n- **${c.slug}** (${c.testName}) - PRs involved: ${c.involvedPrNumbers.join(", ")}`;
            for (const v of c.versions) {
                const origin = v.role === "source" ? `source ${v.sourceName ?? ""} (PR #${v.prNumber ?? "?"})` : v.role;
                prompt += `\n    - ${origin}: assignment \`${v.assignmentId}\`, plan \`${v.planId ?? "<quarantined>"}\``;
            }
        }
    }

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
A test is quarantined when its entry in \`list_tests\` or \`read_test\` carries a \`quarantine\` field (with \`reason\`, and a \`bugId\` or \`issueId\` link). Quarantined tests are known-broken (either an application bug or an engine limitation) and are suppressed from replay. Do NOT mark them affected, and do NOT suggest a new test that duplicates the flow a quarantined test already covers - that flow is considered claimed even though the test cannot run.

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
- \`list_tests\`: list tests in a specific flow (folder) - returns slug, name, and quarantine status
- \`read_test\`: read a test's full instruction by slug, including quarantine status when set
- \`read_skill\`: read a skill's full content by slug

### Actions
- \`mark_affected_test\`: flag a test as potentially affected by the changes (must use exact slug, records as \`code_change\`)
- \`explain_merge_conflict\`: attach reasoning to a pre-classified merge-conflict test (slug must be listed in "Pre-classified merge conflicts")
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
