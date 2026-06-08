import type { UploadedVideo } from "@autonoma/ai";
import type { ModelMessage } from "ai";
import { summarizeScenarioData } from "../../scenario-data";
import { MessageBuilder } from "../kernel";
import type { ReplayChangeContext, RunContext } from "./types";

export function buildReplayReviewMessages(context: RunContext, video: UploadedVideo | undefined): ModelMessage[] {
    const builder = new MessageBuilder()
        .section("Test Plan", context.testPlanPrompt)
        .section("Test Case", `**Name:** ${context.testCaseName}`);

    if (context.change != null) {
        builder.section("Code Change Under Review", buildChangeContextSection(context.change));
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

/**
 * Renders the DB-sourced change facts the loader gathered, plus the explicit
 * instruction to inspect the actual diff via `git diff` in bash. The raw
 * changed-file list and hunks are deliberately not embedded - the reviewer
 * pulls them from the checked-out tree itself so the prompt stays small and
 * the agent grounds its attribution in the real diff.
 */
function buildChangeContextSection(change: ReplayChangeContext): string {
    const lines = [
        "This run executed against the head commit of a code change. To decide between `engine_error` and `application_bug`, inspect what actually changed by running this in the bash tool:",
        "",
        "```bash",
        `git diff ${change.baseSha}..${change.headSha}`,
        "```",
        "",
        `- **Base SHA** (before the change): \`${change.baseSha}\``,
        `- **Head SHA** (under test): \`${change.headSha}\``,
    ];

    if (change.analysisReasoning != null) {
        lines.push("", "### Change Analysis", change.analysisReasoning);
    }

    if (change.affectedReason != null || change.affectedReasoning != null) {
        lines.push("", "### Why This Test Was Flagged");
        if (change.affectedReason != null) {
            lines.push(`- **Affected reason**: \`${change.affectedReason}\``);
        }
        if (change.affectedReasoning != null) {
            lines.push(change.affectedReasoning);
        }
    }

    return lines.join("\n");
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
