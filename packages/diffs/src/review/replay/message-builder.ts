import type { UploadedVideo } from "@autonoma/ai";
import type { ModelMessage } from "ai";
import { summarizeScenarioData } from "../../scenario-data";
import { MessageBuilder } from "../kernel";
import type { PlanRevision, ReplayChangeContext, ReviewLineage, RunContext } from "./types";

export function buildReplayReviewMessages(context: RunContext, video: UploadedVideo | undefined): ModelMessage[] {
    const builder = new MessageBuilder()
        .section("Test Plan", context.testPlanPrompt)
        .section("Test Case", `**Name:** ${context.testCaseName}`);

    if (context.change != null) {
        builder.section("Code Change Under Review", buildChangeContextSection(context.change));
    }

    if (context.lineage != null) {
        builder.section("Refinement-Loop History (fallible signal)", buildLineageSection(context.lineage));
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
 * Renders the subject test's refinement-loop lineage: the plan-delta (the prior
 * plan vs the current healed plan, plus the healing agent's reasoning) and the
 * earlier iterations' verdicts.
 *
 * The anchoring guard is load-bearing here: this run executed a plan the healing
 * agent *rewrote* in response to an *earlier* verdict that may itself have been
 * wrong. So prior verdicts are framed as explicitly-fallible signal the reviewer
 * must independently re-derive - never as the answer. Without this the
 * iteration-2+ reviewer tends to rubber-stamp the loop's existing theory.
 */
export function buildLineageSection(lineage: ReviewLineage): string {
    const sections = [buildPlanDeltaSection(lineage.planHistory)];

    const priorVerdicts = buildPriorVerdictsSection(lineage.priorVerdicts);
    if (priorVerdicts != null) sections.push(priorVerdicts);

    sections.push(
        [
            "### How to use this history",
            "The plan you are reviewing was **rewritten by an automated healing agent** in response to the prior verdicts above. Those verdicts and the rewrite are an *informed guess that may be wrong*: an earlier reviewer could have misattributed the failure, and the healing agent may then have rewritten the plan on a mistaken theory.",
            "",
            "Treat all of the above as a **fallible lead to investigate, never as the answer**. Re-derive your verdict independently from the video, the step summary, and the actual code diff. If your own analysis contradicts the prior verdicts, trust your analysis and say so explicitly in your reasoning.",
        ].join("\n"),
    );

    return sections.join("\n\n");
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

/**
 * Derives the plan-delta from the rewrite history: the plan the *previous*
 * iteration executed versus the current healed plan the subject run executed,
 * plus the healing agent's stated reasoning for the latest rewrite. Falls back
 * to rendering whatever history is present (a single entry, or none) so the
 * function is total over any non-empty history the loader produces.
 */
function buildPlanDeltaSection(planHistory: PlanRevision[]): string {
    const current = planHistory[planHistory.length - 1];
    if (current == null) return "### Plan Changes\nNo plan history is available.";

    const previous = planHistory[planHistory.length - 2];
    if (previous == null) {
        return [
            "### Plan Changes",
            "Only the current plan is on record:",
            "",
            formatPlan("Current plan", current),
        ].join("\n");
    }

    const lines = [
        "### Plan Changes",
        "The healing agent rewrote this test's plan. The replay you are reviewing executed the **current** plan below, not the previous one.",
        "",
        formatPlan(`Previous plan (iteration ${previous.iterationNumber})`, previous),
        "",
        formatPlan(`Current plan (iteration ${current.iterationNumber}, executed by this run)`, current),
    ];

    if (current.healingReasoning != null) {
        lines.push("", "**Healing agent's reasoning for this rewrite:**", current.healingReasoning);
    }

    return lines.join("\n");
}

function formatPlan(label: string, plan: PlanRevision): string {
    return [`**${label}:**`, "", "```", plan.prompt, "```"].join("\n");
}

/**
 * Renders earlier iterations' verdicts as a list. Returns `undefined` when there
 * are none (a healing rewrite can exist without a recorded prior verdict), so
 * the caller omits the heading entirely rather than printing an empty section.
 */
function buildPriorVerdictsSection(priorVerdicts: ReviewLineage["priorVerdicts"]): string | undefined {
    if (priorVerdicts.length === 0) return undefined;

    const items = priorVerdicts.map((v) =>
        [`- **Iteration ${v.iterationNumber}** judged this \`${v.verdict}\`.`, `  Reasoning: ${v.reasoning}`].join(
            "\n",
        ),
    );

    return ["### Prior Verdicts On This Test", ...items].join("\n");
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
