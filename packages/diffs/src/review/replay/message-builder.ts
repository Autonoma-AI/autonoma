import type { UploadedVideo } from "@autonoma/ai";
import type { ModelMessage } from "ai";
import { summarizeScenarioData } from "../../scenario-data";
import { MessageBuilder, buildChangeContextSection, buildLineageSection } from "../kernel";
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
        .section("Step Summary", buildStepSummary(context))
        .closingPrompt(
            "The step summary above shows every step the replay engine executed. Decide whether the failure is due to outdated step definitions (`engine_error`) or a real application bug (`application_bug`), then submit your verdict.",
        )
        .build();
}

function buildStepSummary(context: RunContext): string {
    if (context.steps.length === 0) return "No steps were executed.";

    return context.steps
        .map((step) => {
            const output = step.output as Record<string, unknown> | undefined;
            const outcome = output?.outcome ?? "unknown";
            const hasScreenshots = step.screenshotBeforeKey != null || step.screenshotAfterKey != null;

            const lines = [
                `### Step ${step.order}: ${step.interaction}`,
                `- **Parameters**: ${JSON.stringify(step.params)}`,
                `- **Output**: ${JSON.stringify(output)}`,
                `- **Outcome**: ${outcome}`,
            ];
            if (hasScreenshots) {
                lines.push("- Screenshots available (use view_step_screenshot tool to inspect)");
            }
            return lines.join("\n");
        })
        .join("\n\n");
}
