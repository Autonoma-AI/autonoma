import { tool } from "ai";
import { runAgent } from "../../src/core/agent";
import { buildBashTool, buildGlobTool, buildGrepTool, buildReadFileTool } from "../../src/tools";
import { buildJudgeModel } from "../framework/judge-model";
import { type Verdict, verdictSchema } from "./verdict";

const MAX_JUDGE_STEPS = 40;

const SYSTEM_PROMPT = `You are grading an agent's Autonoma SDK integration against the client's real
("golden") integration of the same repo. You are skeptical: VERIFY claims with the tools
(git, grep, read_file) rather than trusting file names or comments. Both integrations start
from the identical clean tree, so their diffs are directly comparable. When the agent used a
newer SDK version or different-but-equivalent conventions than golden, judge FUNCTIONAL parity,
not textual similarity. Cite file:line evidence for every dimension. Call finish exactly once.`;

export interface JudgeInput {
    /** Dir containing agent/ and golden/ trees, the diffs, transcript, and spec/. */
    judgeRoot: string;
    modelId?: string;
}

/**
 * Run the agentic judge over the staged trees and return the structured verdict.
 * The judge has bash/grep/read rooted at `judgeRoot`, so it can `git diff` in either
 * tree and read the transcript for the agent's own discover/up/down validation.
 */
export async function judgeRun(input: JudgeInput): Promise<Verdict | undefined> {
    const root = input.judgeRoot;
    let result: Verdict | undefined;

    const finishTool = tool({
        description: "Submit the final structured verdict comparing the agent integration to golden.",
        inputSchema: verdictSchema,
        execute: async (verdict) => {
            result = verdict;
            return { accepted: true };
        },
    });

    const prompt = `Grade the integration under this directory (all paths are relative to it):
  • agent/           the agent's working tree (run \`git diff\` in it to see exactly what it added)
  • golden/          the client's real integrated tree (the answer key)
  • agent.diff       the agent's additions, pre-extracted
  • golden.diff      the client's additions, pre-extracted
  • spec/entity-audit.md, spec/recipe.json   the entities that required factories, and the recipe
  • progress.log, claude.stream.jsonl        the agent's transcript - consult it for whether the
                                             agent actually ran signed discover/up/down and got them green

Grade these, verifying each with the tools:
  1. factoryCoverage: from spec/entity-audit.md, list every entity that needed a factory, then
     check the agent tree for a working factory per entity. covered vs missing.
  2. endpointImplemented: a discover/up/down endpoint wired through the SDK handler, verifying the
     x-signature HMAC against the env secret (not a hardcoded/overwritten secret).
  3. realCreationPaths: factories create through the app's own creation code (services/inlined
     inserts), not raw DB writes - compare against how golden does it.
  4. teardownScoped: teardown is scoped to test data and reverses dependency order.
  5. realAuth: the auth callback returns real usable credentials, not a placeholder.
  passed = did the agent reach functional parity with golden across coverage + the four dimensions.

Explore with git/grep/read_file first; then call finish with the verdict.`;

    await runAgent(
        {
            id: "sdk-integration-judge",
            systemPrompt: SYSTEM_PROMPT,
            model: buildJudgeModel(input.modelId),
            maxSteps: MAX_JUDGE_STEPS,
            temperature: 0,
            tools: async () => ({
                read_file: buildReadFileTool(root),
                glob: buildGlobTool(root),
                grep: buildGrepTool(root),
                bash: buildBashTool(root),
                finish: finishTool,
            }),
        },
        prompt,
        () => result,
    );

    return result;
}
