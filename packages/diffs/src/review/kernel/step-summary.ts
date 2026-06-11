import type { ReviewStep } from "./review-step";

/**
 * A {@link ReviewStep} enriched with the presentation metadata the summary needs
 * but the command-aware core does not: its position in the attempt timeline
 * (used both for the heading and as the `view_step_screenshot` key) and the
 * screenshot keys that decide whether to advertise the screenshot tool. Both
 * reviewers' step shapes structurally satisfy this.
 */
export interface RenderableReviewStep extends ReviewStep {
    order: number;
    screenshotBeforeKey?: string;
    screenshotAfterKey?: string;
}

/**
 * One-line guard prepended whenever the summary contains a failed attempt. It
 * frames `errorName` as a classifier, not a verdict, so the reviewer treats it
 * as a lead to investigate rather than the answer.
 */
const ERROR_NAME_GUARD =
    "_Note: a step's error type is a classifier, not a verdict - e.g. `ElementNotFoundError` can mean a stale step or a genuinely missing element. Decide from the diff and screenshots, not the error name alone._";

/**
 * Render the shared "Step Summary" section both reviewers inline into their
 * prompt. Switches on each step's `interaction` to surface the high-signal
 * structured output on success and the `errorName` + message on failure, with
 * all narrowing done locally (no `as`, no Zod, no stored discriminant).
 *
 * The generation path feeds this the full `StepAttempt` timeline - failures
 * included - so the most diagnostic moments are no longer invisible.
 */
export function buildStepSummary(steps: readonly RenderableReviewStep[]): string {
    if (steps.length === 0) return "No steps were executed.";

    const body = steps.map(renderStep).join("\n\n");
    const hasFailedAttempt = steps.some((step) => step.status === "failed");
    if (!hasFailedAttempt) return body;

    return `${ERROR_NAME_GUARD}\n\n${body}`;
}

function renderStep(step: RenderableReviewStep): string {
    const lines = [`### Step ${step.order}: ${step.interaction}`, `- **Parameters**: ${JSON.stringify(step.params)}`];

    if (step.status === "success") {
        lines.push(...renderSuccess(step));
    } else {
        lines.push(...renderFailure(step));
    }

    if (step.screenshotBeforeKey != null || step.screenshotAfterKey != null) {
        lines.push("- Screenshots available (use view_step_screenshot tool to inspect)");
    }

    return lines.join("\n");
}

function renderSuccess(step: RenderableReviewStep): string[] {
    const lines = ["- **Status**: success"];

    if (!isRecord(step.output)) return lines;

    const outcome = readString(step.output, "outcome");
    if (outcome != null) lines.push(`- **Outcome**: ${outcome}`);

    lines.push(...renderCommandOutput(step.interaction, step.output));
    return lines;
}

function renderFailure(step: RenderableReviewStep): string[] {
    const lines = ["- **Status**: failed"];
    if (step.errorName != null) lines.push(`- **Error type**: \`${step.errorName}\``);
    if (step.error != null) lines.push(`- **Error message**: ${step.error}`);
    return lines;
}

/**
 * Surface each command's high-signal output fields. Known commands get a
 * curated projection; anything else falls back to the raw structured output so
 * no signal is silently dropped.
 */
function renderCommandOutput(interaction: string, output: Record<string, unknown>): string[] {
    switch (interaction) {
        case "assert":
            return renderAssertResults(output);
        case "wait-until":
        case "scroll":
            return renderConditionCheck(output);
        case "click":
        case "hover":
        case "type":
            return renderPoint(output, "point", "Resolved point");
        case "drag":
            return [
                ...renderPoint(output, "startPoint", "Start point"),
                ...renderPoint(output, "endPoint", "End point"),
            ];
        case "read":
        case "save-clipboard":
            return renderValue(output);
        case "navigate":
        case "refresh":
            return renderUrl(output);
        default:
            return renderRawOutput(output);
    }
}

/**
 * The `assert` command's per-assertion results - the strongest false-positive
 * signal, since a step can report `outcome: success` while an individual
 * assertion did not actually hold.
 */
function renderAssertResults(output: Record<string, unknown>): string[] {
    const results = output["results"];
    if (!Array.isArray(results)) return [];

    return results.map((entry, index) => {
        if (!isRecord(entry)) return `- **Assertion ${index + 1}**: ${JSON.stringify(entry)}`;
        const assertion = readString(entry, "assertion") ?? "(unknown assertion)";
        const metCondition = readBoolean(entry, "metCondition") ?? "unknown";
        const reason = readString(entry, "reason");
        const reasonSuffix = reason != null && reason !== "" ? ` (${reason})` : "";
        return `- **Assertion**: ${assertion} - met: ${metCondition}${reasonSuffix}`;
    });
}

/** The `conditionMet` + `reasoning` a `wait-until`/`scroll` step resolved to. */
function renderConditionCheck(output: Record<string, unknown>): string[] {
    const lines: string[] = [];
    const conditionMet = readBoolean(output, "conditionMet");
    if (conditionMet != null) lines.push(`- **Condition met**: ${conditionMet}`);
    const reasoning = readString(output, "reasoning");
    if (reasoning != null) lines.push(`- **Reasoning**: ${reasoning}`);
    return lines;
}

/** A resolved coordinate (e.g. the element a click/type/hover landed on). */
function renderPoint(output: Record<string, unknown>, key: string, label: string): string[] {
    const point = output[key];
    if (point == null) return [];
    return [`- **${label}**: ${JSON.stringify(point)}`];
}

function renderValue(output: Record<string, unknown>): string[] {
    const value = readString(output, "value");
    if (value == null) return [];
    return [`- **Value**: ${value}`];
}

function renderUrl(output: Record<string, unknown>): string[] {
    const url = readString(output, "url");
    if (url == null) return [];
    return [`- **URL**: ${url}`];
}

/** Fallback for commands without a curated projection: the full structured output. */
function renderRawOutput(output: Record<string, unknown>): string[] {
    return [`- **Output**: ${JSON.stringify(output)}`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
    const value = record[key];
    return typeof value === "boolean" ? value : undefined;
}
