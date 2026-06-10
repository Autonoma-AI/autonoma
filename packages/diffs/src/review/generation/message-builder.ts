import type { UploadedVideo } from "@autonoma/ai";
import type { ModelMessage } from "ai";
import { summarizeScenarioData } from "../../scenario-data";
import { MessageBuilder, buildChangeContextSection, buildLineageSection, sanitizeConversation } from "../kernel";
import type { GenerationContext } from "./types";

const CHANGE_CONTEXT_INTRO =
    "This generation executed against the head commit of a code change. To attribute the failure between `plan_mismatch`, `application_bug`, and `agent_limitation`, inspect what actually changed by running this in the bash tool:";

/**
 * Builds the user-message script the reviewer agent sees. Pure function of the
 * context + (optionally uploaded) video; no DB, no S3, no agent state.
 */
export function buildGenerationReviewMessages(
    context: GenerationContext,
    video: UploadedVideo | undefined,
): ModelMessage[] {
    const builder = new MessageBuilder()
        .section("Test Plan", context.testPlanPrompt)
        .section(
            "Self-reported outcome",
            `The execution agent self-reported status: \`${context.selfReportedStatus}\`. ` +
                "Treat this as a hint only - your verdict is the source of truth.",
        );

    if (context.change != null) {
        builder.section("Code Change Under Review", buildChangeContextSection(context.change, CHANGE_CONTEXT_INTRO));
    }

    if (context.lineage != null) {
        builder.section(
            "Refinement-Loop History (fallible signal)",
            buildLineageSection(context.lineage, "generation"),
        );
    }

    if (context.scenario != null) {
        builder.section("Scenario Data", summarizeScenarioData(context.scenario));
    }

    builder
        .video(video, "The video above shows the complete execution recording.")
        .section("Step Summary", buildStepSummary(context));

    if (context.reasoning != null) {
        builder.section("Agent's Final Reasoning", context.reasoning);
    }

    builder.text(
        "## Agent Conversation\n\nThe following messages are the execution agent's conversation during the run. " +
            "Review them to understand its reasoning and actions. Images have been stripped - use the screenshot tools if you need visuals.",
    );

    builder.append(...sanitizeConversation(context.conversation));
    builder.closingPrompt(
        "The agent conversation above is now complete. Decide whether the generation truly succeeded; if not, classify the failure cause. Then submit your verdict.",
    );

    return builder.build();
}

function buildStepSummary(context: GenerationContext): string {
    if (context.steps.length === 0) return "No steps were executed.";

    return context.steps
        .map((step) => {
            const output = step.output as Record<string, unknown> | undefined;
            const success = output?.success ?? "unknown";
            const result = output?.result ?? output?.error ?? "";
            const hasScreenshots = step.screenshotBeforeKey != null || step.screenshotAfterKey != null;

            const lines = [
                `### Step ${step.order}: ${step.interaction}`,
                `- **Parameters**: ${JSON.stringify(step.params)}`,
                `- **Success**: ${success}`,
                `- **Result**: ${JSON.stringify(result)}`,
            ];
            if (hasScreenshots) {
                lines.push("- Screenshots available (use view_step_screenshot tool to inspect)");
            }
            return lines.join("\n");
        })
        .join("\n\n");
}
