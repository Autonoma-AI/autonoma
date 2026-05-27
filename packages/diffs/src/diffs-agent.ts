import { AI_REQUEST_TIMEOUT_MS, extractMessages } from "@autonoma/ai";
import { logger, type Logger } from "@autonoma/logger";
import { type LanguageModel, ToolLoopAgent, hasToolCall } from "ai";
import { buildDiffAnalysis } from "./diff-analysis";
import type { FlowIndex } from "./flow-index";
import { PLAN_AUTHORING_GUIDE, buildPlanAuthoringContext } from "./healing/plan-authoring";
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
    /** Merges present in the range that were deterministically processed before the agent ran. Empty for non-merge runs. */
    merges?: MergeContextInfo[];
    /** Merge-conflict tests to enrich with reasoning. Empty for non-merge runs. */
    preClassifiedConflicts?: PreClassifiedConflictInfo[];
    /** Free-text testing guidelines from the application owner. */
    testScopeGuidelines?: string;
}

// --- Agent ---

export interface DiffsAgentConfig {
    model: LanguageModel;
    workingDirectory: string;
    flowIndex: FlowIndex;
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
                merges: input.merges ?? [],
                preClassifiedConflicts: input.preClassifiedConflicts ?? [],
                testScopeGuidelines: input.testScopeGuidelines,
            },
            this.config.flowIndex,
        );
        const validSlugs = new Set(input.existingTests.map((t) => t.slug));
        const quarantinedSlugs = new Set(input.existingTests.filter((t) => t.quarantine != null).map((t) => t.slug));
        const preClassifiedConflicts = input.preClassifiedConflicts ?? [];

        return await this.runAgent(prompt, validSlugs, quarantinedSlugs, preClassifiedConflicts, input.existingTests);
    }

    private async runAgent(
        prompt: string,
        validSlugs: Set<string>,
        quarantinedSlugs: Set<string>,
        preClassifiedConflicts: PreClassifiedConflictInfo[],
        existingTests: ExistingTestInfo[],
    ): Promise<DiffsAgentResult> {
        const { model, workingDirectory, flowIndex } = this.config;

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
            instructions: `${SYSTEM_PROMPT}\n\n${PLAN_AUTHORING_GUIDE}`,
            timeout: AI_REQUEST_TIMEOUT_MS,
            tools: {
                ...buildCodebaseTools(model, workingDirectory),
                ...buildTestInteractionTools(flowIndex, existingTests),
                ...buildActionTools(collector, validSlugs, validConflictSlugs, quarantinedSlugs),
                finish: buildFinishTool((output) => (result = output), collector),
            },
            stopWhen: [hasToolCall("finish")],
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

        if (result == null || result.reasoning.trim() === "") {
            this.logger.error(
                "Agent finished without calling finish tool or with empty reasoning. Returning partial results with a warning.",
                {
                    partialResult: collector,
                },
            );

            throw new Error(
                "Diffs agent did not produce a final result. This may be due to a failure to call the finish tool or an empty reasoning output. Partial results have been collected and logged, but the final output is incomplete.",
            );
        }

        return { ...result, conversation };
    }
}

interface PromptInput {
    analysis: DiffAnalysis;
    existingTests: ExistingTestInfo[];
    merges: MergeContextInfo[];
    preClassifiedConflicts: PreClassifiedConflictInfo[];
    testScopeGuidelines?: string;
}

function buildPrompt(input: PromptInput, flowIndex: FlowIndex): string {
    const { analysis, merges, preClassifiedConflicts, testScopeGuidelines } = input;

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
            "writing the reasoning - pass every conflict slug in one call. The Resolution step will re-plan them using all the legs listed below.\n";
        for (const c of preClassifiedConflicts) {
            prompt += `\n- **${c.slug}** (${c.testName}) - PRs involved: ${c.involvedPrNumbers.join(", ")}`;
            for (const v of c.versions) {
                const origin = v.role === "source" ? `source ${v.sourceName ?? ""} (PR #${v.prNumber ?? "?"})` : v.role;
                prompt += `\n    - ${origin}: assignment \`${v.assignmentId}\`, plan \`${v.planId ?? "<quarantined>"}\``;
            }
        }
    }

    if (flowIndex.listFlows().length > 0) {
        prompt +=
            "\n\nFlows are listed in the Plan Authoring Context above. Use `list_tests` to see tests in a flow and `read_tests` to inspect specific tests' instructions - always pass every slug you need to read in a single call.";
    }

    prompt += "\n\nAnalyze the diff and take appropriate actions using the available tools. When done, call `finish`.";

    return prompt;
}

const SYSTEM_PROMPT = `You are a QA engineer that analyzes code diffs on pull requests. You have two responsibilities:

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
A test is quarantined when its entry in \`list_tests\` or \`read_tests\` carries a \`quarantine\` field (with \`reason\`, and a \`bugId\` or \`issueId\` link). Quarantined tests are known-broken (either an application bug or an engine limitation) and are suppressed from replay. Do NOT mark them affected, and do NOT suggest a new test that duplicates the flow a quarantined test already covers - that flow is considered claimed even though the test cannot run.

## 2. Test Gap Detection
Identify new functionality that has no test coverage. Use \`suggest_test\` for each new test that should be created. Focus on user-facing behavior introduced by the diff. These suggestions will be reviewed in a later step.

## Available Tools

### Codebase exploration
- \`bash\`: shell commands (git diff, git log, git show, etc.) and basic unix utilities
- \`glob\`: find files by pattern
- \`grep\`: search file contents
- \`read_files\`: read one or more files in a single call. Pass every path you need in the \`files\` array - do not call this tool once per path.
- \`subagent\`: spawn a focused research subagent to investigate a specific area

### Test discovery
- \`list_tests\`: list tests in a specific flow (folder) - returns slug, name, and quarantine status
- \`read_tests\`: read one or more tests' full instructions by slug, including quarantine status when set. Always pass every slug you need in a single \`slugs\` array.

### Actions
- \`mark_affected_test\`: flag a test as potentially affected by the changes (must use exact slug, records as \`code_change\`)
- \`explain_merge_conflict\`: attach reasoning to a pre-classified merge-conflict test (slug must be listed in "Pre-classified merge conflicts")
- \`suggest_test\`: suggest a new test for uncovered functionality
- \`finish\`: call when done with your analysis

## File System Layout
Test files exist on disk at \`autonoma/qa-tests/{slug}.md\`. These files are for reference only - prefer using the \`read_tests\` tool to inspect them. When calling tools, always use plain slug identifiers (e.g. \`login-flow\`), never file paths.

## Workflow
1. Use \`bash\` with git commands (\`git diff HEAD~1\`, \`git show HEAD -- <file>\`, \`git log --oneline -5\`) to explore the actual diff and understand what changed
2. Read relevant source files to understand the changes in context - batch every file you need to read into one \`read_files\` call
3. Browse the test flows using \`list_tests\` to understand what tests exist
4. Identify potentially affected tests by passing every candidate slug to \`read_tests\` in one call, then \`mark_affected_test\` for each affected one
5. Identify test gaps and suggest new tests with \`suggest_test\`
6. Call \`finish\` with your overall reasoning - even if no actions were needed (e.g. pure refactors), explain why`;
