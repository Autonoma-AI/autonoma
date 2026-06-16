import type { IterationLineage } from "./widened-context";

/**
 * Renders the subject test's refinement-loop lineage: the plan-delta (the prior
 * plan vs the current healed plan, plus the healing agent's reasoning) and the
 * earlier iterations' verdicts.
 *
 * The anchoring guard is load-bearing here: the subject executed a plan the
 * healing agent *rewrote* in response to an *earlier* verdict that may itself
 * have been wrong. So prior verdicts are framed as explicitly-fallible signal
 * the reviewer must independently re-derive - never as the answer. Without this
 * the iteration-2+ reviewer tends to rubber-stamp the loop's existing theory.
 *
 * `subjectNoun` names the subject under review ("replay" / "generation") so the
 * shared copy reads naturally for either reviewer.
 */
export function buildLineageSection(lineage: IterationLineage[], subjectNoun: string): string {
    const sections = [buildPlanDeltaSection(lineage, subjectNoun)];

    const priorVerdicts = buildPriorVerdictsSection(lineage);
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
 * Derives the plan-delta from the rewrite history: the plan the *previous*
 * iteration executed versus the current healed plan the subject executed, plus
 * the healing agent's stated reasoning for the latest rewrite. Falls back to
 * rendering whatever history is present (a single entry, or none) so the
 * function is total over any history the loader produces.
 */
function buildPlanDeltaSection(lineage: IterationLineage[], subjectNoun: string): string {
    const current = lineage[lineage.length - 1];
    if (current == null) return "### Plan Changes\nNo plan history is available.";

    const previous = lineage[lineage.length - 2];
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
        `The healing agent rewrote this test's plan. The ${subjectNoun} you are reviewing executed the **current** plan below, not the previous one.`,
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

function formatPlan(label: string, plan: IterationLineage): string {
    return [`**${label}:**`, "", "```", plan.prompt, "```"].join("\n");
}

/**
 * Renders earlier iterations' verdicts as a list. Returns `undefined` when there
 * are none (a healing rewrite can exist without a recorded prior verdict), so
 * the caller omits the heading entirely rather than printing an empty section.
 */
function buildPriorVerdictsSection(lineage: IterationLineage[]): string | undefined {
    const items = lineage.flatMap((iteration) =>
        iteration.verdicts.map((v) =>
            [
                `- **Iteration ${iteration.iterationNumber}** judged this \`${v.verdict}\`.`,
                `  Reasoning: ${v.reasoning}`,
            ].join("\n"),
        ),
    );
    if (items.length === 0) return undefined;

    return ["### Prior Verdicts On This Test", ...items].join("\n");
}
