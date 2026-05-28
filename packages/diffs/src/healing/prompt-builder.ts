import type { HealingInput } from "../agents/healing/healing-agent";
import type { HealingAction } from "./actions";
import { buildPlanAuthoringContext } from "./plan-authoring";
import type { FailureRecord } from "./types";

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
        "You are inside a refinement loop. The codebase is checked out at the current snapshot's head SHA. There is no diff to query.",
    );

    if (input.priorActions.length > 0) {
        sections.push(buildPriorActionsSection(input.priorActions));
    }

    sections.push(buildSnapshotSection(input));

    if (input.failures.length > 0) {
        sections.push(buildFailuresSection(input.failures));
    } else {
        sections.push("# Failures\n\nNone in this batch. Call finish to close out the iteration.");
    }

    sections.push(buildInstructionsSection(input));

    return sections.join("\n\n");
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

function buildFailuresSection(failures: FailureRecord[]): string {
    const parts = [`# Failures (${failures.length})`];
    parts.push(
        "Each failure must be addressed via update_plan, report_bug, report_engine_limitation, or remove_test before you call finish.",
    );

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
    lines.push(`\n**Plan prompt**:\n\`\`\`\n${f.planPrompt}\n\`\`\``);
    return lines.join("\n");
}

function buildInstructionsSection(input: HealingInput): string {
    if (input.failures.length === 0) {
        return [
            "# Instructions",
            "No failures in this batch. Call `finish` immediately with a brief explanation.",
        ].join("\n");
    }

    return [
        "# Instructions",
        "1. Read each failure and the reviewer's reasoning.",
        "2. Look for cross-cutting patterns - if multiple failures share a root cause, explore the codebase once and apply the understanding to all of them.",
        "3. For each failure, choose exactly one action: `update_plan`, `report_bug`, `report_engine_limitation`, or `remove_test`.",
        "4. Call `finish` with a one-paragraph summary when every failure is handled.",
    ].join("\n");
}
