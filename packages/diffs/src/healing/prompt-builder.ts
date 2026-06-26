import type { HealingInput } from "../agents/healing/healing-agent";
import { type ChangeContext, type IterationLineage, buildChangeContextSection } from "../review/kernel";
import { type ScenarioData, summarizeEntities } from "../scenario-data";
import type { HealingAction } from "./actions";
import { buildPlanAuthoringContext } from "./plan-authoring";
import type { FailureRecord } from "./types";

/**
 * Whether this is the loop's final iteration. On the final turn the agent's
 * retry tool (`update_plan`) is withheld - mirrored here so the prompt instructs
 * the agent to triage rather than retry.
 */
function isFinalTurn(input: HealingInput): boolean {
    return input.iteration >= input.maxIterations;
}

/**
 * Builds the user-facing prompt that goes into HealingAgent. The system prompt
 * teaches the agent its job; this prompt gives it the per-call context.
 */
export function buildHealingPrompt(input: HealingInput): string {
    const sections: string[] = [];

    sections.push(
        buildPlanAuthoringContext({
            scenarios: input.planAuthoring.scenarios.listScenarios(),
            flows: input.planAuthoring.flows,
            testScopeGuidelines: input.planAuthoring.testScopeGuidelines,
        }),
    );

    sections.push(`# Refinement iteration ${input.iteration}`);
    sections.push(
        "You are inside a refinement loop. The codebase is checked out at the current snapshot's head SHA, with the base SHA also fetched, so you can inspect what changed with `git diff`.",
    );

    if (isFinalTurn(input)) {
        sections.push(
            `This is the **final iteration** (the loop's ${input.maxIterations}-iteration budget is exhausted). ` +
                "There is no next turn, so retrying is not an option: `update_plan` is unavailable. " +
                "Reach a terminal disposition for every failure - `report_bug`, `report_engine_limitation`, " +
                "`report_unknown_issue`, or `remove_test`. A plan that is still failing here but is not a grounded " +
                "application bug, an engine limitation, or an ungroundable suspected issue should be removed.",
        );
    }

    sections.push(buildChangeFactsSection(input));

    if (input.priorActions.length > 0) {
        sections.push(buildPriorActionsSection(input.priorActions));
    }

    sections.push(buildSnapshotSection(input));

    if (input.failures.length > 0) {
        sections.push(buildFailuresSection(input.failures, isFinalTurn(input)));
    } else {
        sections.push("# Failures\n\nNone in this batch.");
    }

    sections.push(buildInstructionsSection(input));

    return sections.join("\n\n");
}

/**
 * Render the snapshot-level change facts shared by every failure: the diff
 * anchor (SHAs + the `git diff` to run) and the diffs-agent's analysis
 * reasoning. Reuses the reviewers' change-facts presentation so healing reads
 * the same context. The per-test affected reason/reasoning is rendered per
 * failure instead, since it differs across tests.
 *
 * Healing runs against a checked-out head SHA, so change is always present; the
 * loader types it optionally for SHA-less snapshots.
 */
function buildChangeFactsSection(input: HealingInput): string {
    if (input.change == null) {
        throw new Error(`Healing requires change context (snapshot SHAs), absent for snapshot ${input.snapshotId}`);
    }

    const change: ChangeContext = {
        baseSha: input.change.baseSha,
        headSha: input.change.headSha,
        analysisReasoning: input.analysisReasoning,
    };
    return buildChangeContextSection(
        change,
        "# Code Change\n\nThe failing plans were authored against an earlier state of the app. Inspect the diff that triggered this loop to see what moved:",
    );
}

function buildPriorActionsSection(actions: HealingAction[]): string {
    const parts = ["# Prior Actions in This Loop"];
    parts.push("Actions you took in earlier iterations of this refinement loop:");
    for (const a of actions) {
        parts.push(formatPriorAction(a));
    }
    parts.push(
        "\nIf a plan you previously updated is failing again, consider whether your previous rewrite was insufficient (try a different angle) or whether the failure is now a real bug rather than a plan issue.",
    );
    return parts.join("\n");
}

function formatPriorAction(a: HealingAction): string {
    switch (a.kind) {
        case "update_plan":
            return `- update_plan(planId=${a.planId}, testCaseId=${a.testCaseId}): ${truncate(a.reasoning)}`;
        case "report_bug":
            return `- report_bug(testCaseId=${a.testCaseId}, title="${a.title}"): ${truncate(a.reasoning)}`;
        case "report_engine_limitation":
            return `- report_engine_limitation(testCaseId=${a.testCaseId}, title="${a.title}"): ${truncate(a.reasoning)}`;
        case "report_unknown_issue":
            return `- report_unknown_issue(testCaseId=${a.testCaseId}, title="${a.title}"): ${truncate(a.reasoning)}`;
        case "remove_test":
            return `- remove_test(testCaseId=${a.testCaseId}): ${truncate(a.reason)}`;
        default: {
            const _exhaustive: never = a;
            return `- unknown action: ${JSON.stringify(_exhaustive)}`;
        }
    }
}

function truncate(s: string, max = 200): string {
    if (s.length <= max) return s;
    return `${s.slice(0, max)}...`;
}

function buildSnapshotSection(input: HealingInput): string {
    return ["# Snapshot", `- snapshotId: ${input.snapshotId}`, `- applicationId: ${input.applicationId}`].join("\n");
}

function buildFailuresSection(failures: FailureRecord[], finalTurn: boolean): string {
    const parts = [`# Failures (${failures.length})`];
    const actions = finalTurn
        ? "report_bug, report_engine_limitation, report_unknown_issue, or remove_test"
        : "update_plan, report_bug, report_engine_limitation, report_unknown_issue, or remove_test";
    parts.push(`Each failure must be addressed via ${actions} before you call finish.`);

    for (const f of failures) {
        parts.push(formatFailure(f));
    }

    return parts.join("\n\n");
}

function formatFailure(f: FailureRecord): string {
    const lines = [
        `## ${f.testCaseName} (slug: \`${f.testCaseSlug}\`)`,
        `- **Failure key**: \`${f.key}\``,
        `- **Source**: ${f.source} (${f.sourceId}, status: ${f.sourceStatus})`,
        `- **Test case ID**: ${f.testCaseId}`,
        `- **Plan ID**: ${f.planId}`,
    ];

    if (f.verdictKind != null) {
        lines.push(`- **Reviewer verdict**: ${f.verdictKind}`);
    }
    if (f.reviewReasoning != null) {
        lines.push(`- **Reviewer reasoning**: ${f.reviewReasoning}`);
    }
    if (f.verdict?.title != null) {
        lines.push(`- **Issue title (from review)**: ${f.verdict.title}`);
    }
    if (f.affectedReason != null) {
        const reasoning = f.affectedReasoning != null ? ` - ${f.affectedReasoning}` : "";
        lines.push(`- **Why flagged**: \`${f.affectedReason}\`${reasoning}`);
    }

    lines.push(`\n**Plan prompt**:\n\`\`\`\n${f.planPrompt}\n\`\`\``);

    if (f.lineage.length > 0) {
        lines.push(`\n${buildFailureLineageSection(f.lineage)}`);
    }
    if (f.scenario != null) {
        lines.push(`\n${buildFailureScenarioSection(f.scenario)}`);
    }

    return lines.join("\n");
}

/**
 * Render the per-test refinement lineage: the rewrites earlier iterations
 * already applied (with their reasoning) and the verdicts those iterations
 * received. This is what lets the iterative agent avoid re-trying a strategy
 * that already failed - if a prior rewrite did not work, it should try a
 * different angle or reconsider whether the failure is a real bug.
 */
function buildFailureLineageSection(lineage: IterationLineage[]): string {
    const parts = [
        "**Refinement lineage for this test** - what earlier iterations already tried, so you do not repeat a strategy that already failed:",
    ];

    // Oldest-first; the last entry is the plan that just failed (already shown
    // above), so render only the *earlier* versions in full here.
    const priorPlans = lineage.slice(0, -1);
    for (const iteration of priorPlans) {
        const reasoning =
            iteration.healingReasoning != null ? `\n  Rewrite reasoning: ${iteration.healingReasoning}` : "";
        parts.push(`- Iteration ${iteration.iterationNumber} plan:\n\`\`\`\n${iteration.prompt}\n\`\`\`${reasoning}`);
    }

    // The most recent rewrite (the one that produced the still-failing current
    // plan) lives on the last entry - surface its reasoning explicitly.
    const current = lineage[lineage.length - 1];
    if (current?.healingReasoning != null) {
        parts.push(`The current plan above was produced by this rewrite: ${current.healingReasoning}`);
    }

    const priorVerdicts = lineage.flatMap((iteration) =>
        iteration.verdicts.map((v) => `  - Iteration ${iteration.iterationNumber}: \`${v.verdict}\` - ${v.reasoning}`),
    );
    if (priorVerdicts.length > 0) {
        parts.push("Prior verdicts on this test:", ...priorVerdicts);
    }

    return parts.join("\n");
}

/**
 * Render the data the failing subject's scenario actually seeded, inlined under
 * its failure. A plan that depends on data the scenario never created points to
 * a stale test the agent should rewrite to match the seed - not an application
 * bug. Mirrors resolution's bounded, inlined scenario summary.
 */
function buildFailureScenarioSection(scenario: ScenarioData): string {
    const body = summarizeEntities(scenario.entities, {
        moreRecords: (entityType, remaining) => `  - ...and ${remaining} more ${entityType} record(s) (not shown).`,
        moreTypes: (remaining) => `  - ...and ${remaining.length} more entity type(s): ${remaining.join(", ")}.`,
    });
    return `**Scenario data** (this subject ran against **${scenario.scenarioName}**). A plan that depends on data not listed here is malformed - rewrite it to match the seeded data rather than reporting a bug:\n${body}`;
}

function buildInstructionsSection(input: HealingInput): string {
    if (input.failures.length === 0) {
        return [
            "# Instructions",
            "No failures in this batch. Call `finish` immediately with a brief explanation.",
        ].join("\n");
    }

    const steps = [
        "Read each failure and the reviewer's reasoning.",
        "Look for cross-cutting patterns - if multiple failures share a root cause, explore the codebase once and apply the understanding to all of them.",
        isFinalTurn(input)
            ? "For each failure, choose exactly one terminal action: `report_bug`, `report_engine_limitation`, `report_unknown_issue`, or `remove_test`. There is no next turn, so `update_plan` is unavailable."
            : "For each failure, choose exactly one action: `update_plan`, `report_bug`, `report_engine_limitation`, `report_unknown_issue`, or `remove_test`.",
        "Call `finish` with a one-paragraph summary once every failure is handled.",
    ];

    const numbered = steps.map((step, i) => `${i + 1}. ${step}`);
    return ["# Instructions", ...numbered].join("\n");
}
