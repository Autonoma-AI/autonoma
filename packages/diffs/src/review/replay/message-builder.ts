import type { UploadedVideo } from "@autonoma/ai";
import type { ModelMessage } from "ai";
import { summarizeScenarioData } from "../../scenario-data";
import { MessageBuilder, buildChangeContextSection, buildLineageSection, buildStepSummary } from "../kernel";
import type { RunContext } from "./types";

const CHANGE_CONTEXT_INTRO =
    "This run executed against the head commit of a code change. To decide between `engine_error` and `application_bug`, inspect what actually changed by running this in the bash tool:";

export function buildReplayReviewMessages(context: RunContext, video: UploadedVideo | undefined): ModelMessage[] {
    const builder = new MessageBuilder()
        .section("Test Plan", context.testPlanPrompt)
        .section("Test Case", `**Name:** ${context.testCaseName}`);

    if (context.change != null) {
        builder.section("Code Change Under Review", buildChangeContextSection(context.change, CHANGE_CONTEXT_INTRO));
    }

    if (context.lineage != null) {
        builder.section("Refinement-Loop History (fallible signal)", buildLineageSection(context.lineage, "replay"));
    }

    if (context.scenario != null) {
        builder.section("Scenario Data", summarizeScenarioData(context.scenario));
    }

    return builder
        .video(video, "The video above shows the complete replay recording.")
        .section("Step Summary", buildStepSummary(context.steps))
        .closingPrompt(
            "The step summary above shows every step the replay engine executed. Decide whether the failure is due to outdated step definitions (`engine_error`) or a real application bug (`application_bug`), then submit your verdict.",
        )
        .build();
}
