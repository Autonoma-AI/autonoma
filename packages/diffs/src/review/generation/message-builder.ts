import type { UploadedVideo } from "@autonoma/ai";
import type { ModelMessage } from "ai";
import { summarizeScenarioData } from "../../scenario-data";
import {
    MessageBuilder,
    buildChangeContextSection,
    buildLineageSection,
    buildStepSummary,
    sanitizeConversation,
} from "../kernel";
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
    // Every reviewed generation executes against a checked-out head SHA, so change
    // is always present; the loader types it optionally for SHA-less snapshots.
    if (context.change == null) {
        throw new Error(
            `Generation review requires change context (snapshot SHAs), absent for generation ${context.generationId}`,
        );
    }

    const builder = new MessageBuilder()
        .section("Test Plan", context.testPlanPrompt)
        .section(
            "Self-reported outcome",
            `The execution agent self-reported status: \`${context.selfReportedStatus}\`. ` +
                "Treat this as a hint only - your verdict is the source of truth.",
        );

    builder.section("Code Change Under Review", buildChangeContextSection(context.change, CHANGE_CONTEXT_INTRO));

    if (context.lineage.length > 0) {
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
        .section("Step Summary", buildStepSummary(context.steps));

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
