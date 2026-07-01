import type { UploadedVideo } from "@autonoma/ai";
import type { ModelMessage } from "ai";
import { summarizeScenarioData } from "../../scenario-data";
import { MessageBuilder, buildChangeContextSection, buildLineageSection, buildStepSummary } from "../kernel";
import type { RunContext } from "./types";

const CHANGE_CONTEXT_INTRO =
    "This run executed against the head commit of a code change. To decide between `engine_error` and `application_bug`, inspect what actually changed by running this in the bash tool:";

export function buildReplayReviewMessages(context: RunContext, video: UploadedVideo | undefined): ModelMessage[] {
    // Every reviewed run executes against a checked-out head SHA, so change is
    // always present; the loader types it optionally for SHA-less snapshots.
    if (context.change == null) {
        throw new Error(`Replay review requires change context (snapshot SHAs), absent for run ${context.runId}`);
    }

    const builder = new MessageBuilder()
        .section("Test Plan", context.testPlanPrompt)
        .section("Test Case", buildTestCaseSection(context.testCaseName, context.testCaseDescription));

    builder.section("Code Change Under Review", buildChangeContextSection(context.change, CHANGE_CONTEXT_INTRO));

    if (context.lineage.length > 0) {
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

/**
 * Render the Test Case section: the loop-stable name and, when present, the
 * description (the diff-system-stable statement of intent, unlike the rewritable
 * plan prompt).
 */
function buildTestCaseSection(name: string, description: string | undefined): string {
    if (description == null || description.trim().length === 0) return `**Name:** ${name}`;
    return [`**Name:** ${name}`, `**Description (loop-stable intent):** ${description}`].join("\n");
}
