import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_REQUEST_TIMEOUT_MS, type LanguageModel, extractMessages } from "@autonoma/ai";
import { buildCodebaseTools } from "@autonoma/codebase";
import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import { buildHealingPrompt } from "./prompt-builder";
import { buildHealingActionTools, createHealingActionCollector } from "./tools/action-tools";
import { BugMatcher, buildFindMatchingBugsTool } from "./tools/find-matching-bugs";
import { buildFinishTool } from "./tools/finish-tool";
import type { HealingInput, HealingResult } from "./types";

const SYSTEM_PROMPT = readFileSync(join(import.meta.dirname, "system-prompt.md"), "utf-8");

export interface HealingAgentConfig {
    model: LanguageModel;
    db: PrismaClient;
    maxSteps?: number;
}

/**
 * Mode-aware agent that diagnoses failing test plans and decides what to do
 * about each one. Same agent for both diffs (single-shot, post code-change)
 * and refinement (iterative, inside refinement loop).
 *
 * Emits a structured action list. The runner is responsible for applying the
 * actions via Temporal activities.
 */
export class HealingAgent {
    private readonly logger: Logger;

    constructor(private readonly config: HealingAgentConfig) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async heal(input: HealingInput): Promise<HealingResult> {
        this.logger.info("Starting healing run", {
            mode: input.mode,
            failureCount: input.failures.length,
            snapshotId: input.snapshotId,
            applicationId: input.applicationId,
            iteration: input.mode === "refinement" ? input.iteration : undefined,
        });

        const collector = createHealingActionCollector();
        const failureKeysByTestCaseId = new Map(input.failures.map((f) => [f.testCaseId, f.key]));
        const failureKeys = new Set(input.failures.map((f) => f.key));

        let finishResult: { reasoning: string } | undefined;
        const onFinish = (r: { reasoning: string }) => {
            finishResult = r;
        };

        const matcher = new BugMatcher(this.config.db, this.config.model);

        const agent = new ToolLoopAgent({
            model: this.config.model,
            instructions: SYSTEM_PROMPT,
            timeout: AI_REQUEST_TIMEOUT_MS,
            tools: {
                ...buildCodebaseTools(input.codebase),
                ...buildFindMatchingBugsTool(matcher),
                ...buildHealingActionTools(collector, failureKeysByTestCaseId, {
                    allowAddTest: input.mode === "diffs",
                }),
                finish: buildFinishTool(collector, failureKeys, onFinish),
            },
            stopWhen: [stepCountIs(this.config.maxSteps ?? 60), hasToolCall("finish")],
            onStepFinish: ({ content }) => {
                this.logger.info("Healing agent step finished", {
                    toolCalls: content
                        .filter((c) => c.type === "tool-call")
                        .map((c) => ({ name: c.toolName, id: c.toolCallId })),
                });
            },
        });

        const userMessage = buildHealingPrompt(input);
        const generateResult = await agent.generate({ messages: [{ role: "user", content: userMessage }] });
        const conversation = extractMessages(generateResult);

        const reasoning =
            finishResult?.reasoning ??
            "Healing agent did not call finish - max steps reached. Actions emitted before truncation are preserved.";

        this.logger.info("Healing run completed", {
            actionCount: collector.actions.length,
            reasoning: reasoning.slice(0, 300),
        });

        return { actions: collector.actions, reasoning, conversation };
    }
}
