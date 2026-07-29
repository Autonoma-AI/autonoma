import { basename } from "node:path";
import { type LanguageModel } from "ai";
import { tool } from "ai";
import { runAgent, buildDefaultStepLogger } from "../../core/agent";
import { buildReadFileTool, buildGrepTool, buildGlobTool, buildBashTool } from "../../tools";
import { reviewResultRecordSchema, type ReviewRubric, type DimensionResult } from "./rubrics";

// Review agents read source to justify each verdict, so a step legitimately runs
// long - and they run 16-wide, which slows every one of them down further. The
// 120s default turned that into a timeout storm.
const REVIEW_STEP_TIMEOUT_MS = 300_000;

// One attempt. A retry restarts the whole review from the first message, and a
// review that never returns is not a failure the caller propagates - it fails
// open to "pass" either way. Three attempts bought nothing and cost 3x the wall
// clock on exactly the agents that were already the slowest.
const REVIEW_MAX_RETRIES = 1;

export async function runReviewPass(
    testContent: string,
    testPath: string,
    rubric: ReviewRubric,
    projectRoot: string,
    model: LanguageModel,
    scenarioData?: string,
): Promise<Record<string, DimensionResult> | undefined> {
    let result: Record<string, DimensionResult> | undefined;

    const agentLabel = `review:${rubric.name}:${basename(testPath)}`;
    const { onStepFinish } = buildDefaultStepLogger(agentLabel, rubric.maxSteps);

    const finishTool = tool({
        description: "Submit your structured review. Every dimension must have evidence from your investigation.",
        inputSchema: rubric.resultSchema,
        execute: async (input) => {
            // input already satisfied rubric.resultSchema upstream; re-parsing through
            // the concrete record schema recovers the precise type without an assertion.
            result = reviewResultRecordSchema.parse(input);
        },
    });

    const agentConfig = {
        id: agentLabel,
        systemPrompt: rubric.systemPrompt,
        model,
        maxSteps: rubric.maxSteps,
        stepTimeoutMs: REVIEW_STEP_TIMEOUT_MS,
        maxRetries: REVIEW_MAX_RETRIES,
        tools: (_heartbeat: () => void) => ({
            read_file: buildReadFileTool(projectRoot),
            grep: buildGrepTool(projectRoot),
            glob: buildGlobTool(projectRoot),
            bash: buildBashTool(projectRoot),
            finish: finishTool,
        }),
        onStepFinish,
    };

    const scenarioContext =
        scenarioData && rubric.name === "data-accuracy"
            ? `\n## Scenario data (the ONLY test data that exists in the database)\n\`\`\`\n${scenarioData}\n\`\`\`\n\nIMPORTANT: Every piece of data the test references (names, titles, URLs, folder names, etc.) MUST exist in the scenario data above. If the test uses a value that doesn't appear in scenarios, it FAILS the dataAccuracy dimension.\n`
            : "";

    const prompt = `Review this E2E test plan:

## Test file: ${testPath}
\`\`\`
${testContent}
\`\`\`
${scenarioContext}
Evaluate EVERY dimension in your rubric: ${rubric.dimensions.join(", ")}

For each one:
1. Investigate using your tools (read source files, grep for strings referenced in the test)
2. Provide specific evidence of what you found
3. Pass or fail with a clear reason

When done, call finish with your structured evaluation.`;

    await runAgent(agentConfig, prompt, () => result);
    return result ?? undefined;
}
