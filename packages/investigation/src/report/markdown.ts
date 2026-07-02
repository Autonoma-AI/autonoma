import { diffLines } from "diff";
import type { DeployedAgentComparison } from "../db/deployed-comparison";

/** A verdict as the report renders it (string-typed, so both RunVerdict and the workflow's verdict fit). */
export interface ReportableEvidence {
    source: string;
    detail: string;
    file?: string;
    lines?: string;
    snippet?: string;
}
export interface ReportableVerdict {
    category: string;
    confidence: string;
    planFidelity?: string;
    headline: string;
    falsePositiveRisk: string;
    whatHappened: string;
    rootCause: string;
    remediation: string;
    suggestedTestUpdate?: string;
    observedAppIssues?: string;
    evidence: ReportableEvidence[];
}

/** One model's verdict (or its error) for a test in the report. */
export interface ModelVerdict {
    model: string;
    verdict?: ReportableVerdict;
    error?: string;
}

/** One test's section of the report: the run, the per-model verdicts, the ORIGINAL plan, and media links. */
export interface TestReport {
    slug: string;
    /** The test's current plan, used to render the suggested update as a diff. */
    plan: string;
    runSuccess: boolean;
    stepCount: number;
    /** The step-by-step run trace (interaction + status + per-step error) - the run agent's observation log. */
    runSteps?: string[];
    verdicts: ModelVerdict[];
    videoUrl?: string;
    finalScreenshotUrl?: string;
    /** How a scenario failure should be repaired (present for diagnosed scenario_issue results). */
    scenarioDiagnosis?: ReportableScenarioDiagnosis;
}

/** The scenario-repair diagnoser's routing for a scenario failure (how it should be fixed). */
export interface ReportableScenarioDiagnosis {
    route: string;
    confidence: string;
    reasoning: string;
    testFix?: string;
    recipeChange?: string;
    factoryIssue?: string;
    /** The concrete candidate `create` graph (JSON string); validated on the twin when autofix is on, else a dry-run. */
    proposedRecipeCreateGraph?: string;
    /** One-sentence summary of the proposed recipe edit. */
    proposedRecipeSummary?: string;
    /** Whether autofix VALIDATED the repair on the twin (autofix-enabled orgs only); absent for a pure dry-run. */
    applied?: boolean;
    /** What the autofix validation pass did (branch-scoped; never a write to main). */
    appliedNote?: string;
}

/** Outcome of running a proposed/modified plan through the validate->edit->retry loop. */
export interface ReportableValidation {
    passed: boolean;
    iterations: number;
    failureReason?: string;
}

/** A new test the agent proposes for brand-new functionality (a full E2E plan). */
export interface ReportableNewTest {
    name: string;
    instruction: string;
    reasoning: string;
    validation?: ReportableValidation;
}

/** An existing test the agent recommends quarantining (the PR removed the functionality it covers). */
export interface ReportableQuarantine {
    slug: string;
    reason: string;
}

/** Everything needed to render the investigation report (the S3 markdown that replaces the Notion page). */
export interface InvestigationReportInput {
    client: string;
    appSlug: string;
    prNumber: number;
    prTitle?: string;
    prBody?: string;
    /** owner/repo for the app's GitHub repository (for code permalinks in the UI; not rendered into markdown). */
    repoFullName?: string;
    /** The PR head commit the run tested (the permalink ref; not rendered into markdown). */
    commitSha?: string;
    tests: TestReport[];
    suggested: ReportableNewTest[];
    quarantine: ReportableQuarantine[];
    deployed: DeployedAgentComparison;
}

const PR_BODY_LIMIT = 4000;

/** Render the suggested test update as a unified-ish diff against the test's current plan. */
function renderPlanDiff(original: string, suggested: string): string[] {
    const before = original.trim() === "" ? "(no existing plan)\n" : original;
    const lines: string[] = ["```diff"];
    for (const part of diffLines(before, suggested)) {
        const prefix = part.added ? "+" : part.removed ? "-" : " ";
        for (const line of part.value.replace(/\n$/, "").split("\n")) {
            lines.push(`${prefix}${line}`);
        }
    }
    lines.push("```");
    return lines;
}

function renderEvidence(verdict: ReportableVerdict): string[] {
    const lines: string[] = ["", "**Evidence:**"];
    for (const item of verdict.evidence) {
        const location = item.file != null ? ` (\`${item.file}${item.lines != null ? `:${item.lines}` : ""}\`)` : "";
        lines.push(`- [${item.source}]${location} ${item.detail}`);
        if (item.snippet != null && item.snippet !== "") {
            lines.push("", "```", item.snippet, "```");
        }
    }
    return lines;
}

/** The step-by-step run trace - what the run ACTUALLY did, so the verdict can be audited against it. */
function renderRunTrace(test: TestReport): string[] {
    if (test.runSteps == null || test.runSteps.length === 0) return [];
    return [
        "<details>",
        "<summary>Run trace (what the run actually did, step by step)</summary>",
        "",
        "```",
        ...test.runSteps,
        "```",
        "",
        "</details>",
        "",
    ];
}

/** App problems the agent saw in the video INDEPENDENT of the test's pass/fail - surfaced prominently. */
function renderObservedIssues(verdict: ReportableVerdict): string[] {
    if (verdict.observedAppIssues == null || verdict.observedAppIssues.trim() === "") return [];
    return [`> ⚠️ **App issues observed (independent of this test):** ${verdict.observedAppIssues}`, ""];
}

/** One verdict, in the UI-emulating layout: one-liner -> summary -> remediation -> collapsible deep dive. */
function renderVerdict(test: TestReport, verdict: ReportableVerdict): string[] {
    const links = [
        test.finalScreenshotUrl != null ? `[final screenshot](${test.finalScreenshotUrl})` : undefined,
        test.videoUrl != null ? `[run video](${test.videoUrl})` : undefined,
    ].filter((link): link is string => link != null);

    const lines = [
        `## ${verdict.headline}`,
        "",
        `\`${test.slug}\` · **${verdict.category}** · ${verdict.confidence} confidence · plan: ${verdict.planFidelity ?? "?"}`,
        links.length > 0 ? links.join(" · ") : "",
        "",
        verdict.whatHappened,
        "",
        ...renderObservedIssues(verdict),
        `**Remediation:** ${verdict.remediation}`,
        "",
        ...renderScenarioDiagnosis(test.scenarioDiagnosis),
        ...renderPlanOrFix(test, verdict),
        ...renderRunTrace(test),
        "<details>",
        "<summary>Root cause &amp; evidence</summary>",
        "",
        `**Root cause:** ${verdict.rootCause}`,
        "",
        `**False-positive check:** ${verdict.falsePositiveRisk}`,
        ...renderEvidence(verdict),
        "",
        "</details>",
    ];
    return lines;
}

const SCENARIO_ROUTE_LABEL: Record<string, string> = {
    fix_test: "Fix the test",
    recipe_only: "Edit the scenario recipe",
    recipe_and_sdk: "Client factory change needed",
    unknown: "Not a scenario-data problem",
};

/**
 * The scenario-repair diagnoser's routing: HOW this scenario failure should be fixed - a scoped test edit, a
 * recipe change, an escalation to the client's factory, or "not a data problem". Observe-only; nothing has
 * acted on it. Rendered right under the remediation so the reader sees the recommended lever immediately.
 */
function renderScenarioDiagnosis(diagnosis: ReportableScenarioDiagnosis | undefined): string[] {
    if (diagnosis == null) return [];
    const label = SCENARIO_ROUTE_LABEL[diagnosis.route] ?? diagnosis.route;
    const lines = [
        `**Scenario repair route:** ${label} (\`${diagnosis.route}\`, ${diagnosis.confidence} confidence) - ${diagnosis.reasoning}`,
    ];
    if (diagnosis.testFix != null && diagnosis.testFix !== "") lines.push(`- Test fix: ${diagnosis.testFix}`);
    if (diagnosis.recipeChange != null && diagnosis.recipeChange !== "") {
        lines.push(`- Recipe change: ${diagnosis.recipeChange}`);
    }
    if (diagnosis.factoryIssue != null && diagnosis.factoryIssue !== "") {
        lines.push(`- Client factory change: ${diagnosis.factoryIssue}`);
    }
    lines.push(...renderProposedRecipe(diagnosis));
    if (diagnosis.applied != null) {
        const status = diagnosis.applied ? "VALIDATED (branch-scoped)" : "not validated";
        lines.push(`- Autofix: **${status}**${diagnosis.appliedNote != null ? ` - ${diagnosis.appliedNote}` : ""}`);
    }
    lines.push("");
    return lines;
}

/**
 * The concrete candidate recipe that fixes a recipe_only/recipe_and_sdk failure. A DRY-RUN preview: with autofix
 * on it is staged + validated on the twin (branch-scoped), never written to main. The full create graph is
 * collapsed so the summary stays skimmable.
 */
function renderProposedRecipe(diagnosis: ReportableScenarioDiagnosis): string[] {
    const graph = diagnosis.proposedRecipeCreateGraph;
    if (graph == null || graph === "") return [];
    const summary = diagnosis.proposedRecipeSummary;
    return [
        `- Proposed recipe (validated on the twin when autofix is on; branch-scoped)${summary != null && summary !== "" ? `: ${summary}` : ""}`,
        "  <details>",
        "  <summary>Candidate create graph</summary>",
        "",
        "  ```json",
        graph,
        "  ```",
        "",
        "  </details>",
    ];
}

/**
 * Always give the reader the test itself to compare against: the proposed fix as a DIFF when there is one
 * (so a bad/outdated test shows exactly how to repair it - not "bad forever"), otherwise the current plan.
 */
function renderPlanOrFix(test: TestReport, verdict: ReportableVerdict): string[] {
    const fix = verdict.suggestedTestUpdate;
    if (fix != null && fix !== "") {
        return [
            "**Suggested test fix** - diff vs. the current plan (`-` current, `+` proposed; stays broken until applied):",
            "",
            ...renderPlanDiff(test.plan, fix),
            "",
        ];
    }
    if (test.plan.trim() === "") return [];
    return [
        "<details>",
        "<summary>Test plan (what the run was checked against)</summary>",
        "",
        "```",
        test.plan,
        "```",
        "",
        "</details>",
        "",
    ];
}

function renderTest(test: TestReport): string[] {
    const lines: string[] = [];
    for (const entry of test.verdicts) {
        if (entry.verdict == null) {
            lines.push(`## ${test.slug} - classification error`, "", entry.error ?? "(no verdict)", "");
            lines.push(...renderRunTrace(test));
            continue;
        }
        lines.push(...renderVerdict(test, entry.verdict), "");
    }
    return lines;
}

/** A one-line validation badge for a proposed/modified plan. */
function validationBadge(validation: ReportableValidation | undefined): string {
    if (validation == null) return "_not yet validated (run the validate loop)_";
    if (validation.passed) return `✓ **validated** - passes after ${validation.iterations} iteration(s)`;
    return `✗ **could not pass** after ${validation.iterations} iteration(s)${validation.failureReason != null ? ` - ${validation.failureReason}` : ""}`;
}

/** New-test proposals for brand-new functionality (the agent's gap detection, mirroring the deployed agent). */
function renderSuggestedTests(suggested: ReportableNewTest[]): string[] {
    if (suggested.length === 0) return [];
    const lines = ["## Proposed new tests", ""];
    for (const test of suggested) {
        lines.push(
            `### ${test.name}`,
            "",
            test.reasoning,
            "",
            validationBadge(test.validation),
            "",
            "<details>",
            "<summary>Proposed plan</summary>",
            "",
            "```",
            test.instruction,
            "```",
            "",
            "</details>",
            "",
        );
    }
    return lines;
}

/** Quarantine recommendations for tests whose functionality the PR removed. */
function renderQuarantine(quarantine: ReportableQuarantine[]): string[] {
    if (quarantine.length === 0) return [];
    const lines = [
        "## Quarantine recommendations",
        "",
        "_Tests whose functionality this PR removed - they can no longer pass:_",
        "",
    ];
    for (const item of quarantine) {
        lines.push(`- \`${item.slug}\` - ${item.reason}`);
    }
    lines.push("");
    return lines;
}

/** The PR title inline + the body inside a collapsible (rendered as markdown - never wrapped in a raw fence). */
function renderPrSection(input: InvestigationReportInput): string[] {
    const prTitle = (input.prTitle ?? "").trim();
    const prBody = (input.prBody ?? "").trim();
    if (prTitle === "" && prBody === "") return [];
    const lines = [`**PR #${input.prNumber}:** ${prTitle !== "" ? prTitle : "(untitled)"}`, ""];
    if (prBody !== "") {
        lines.push(
            "<details>",
            "<summary>PR description</summary>",
            "",
            prBody.slice(0, PR_BODY_LIMIT),
            "",
            "</details>",
            "",
        );
    }
    return lines;
}

function renderDeployedComparison(deployed: DeployedAgentComparison): string[] {
    if (!deployed.found) {
        return [
            "<details>",
            "<summary>Deployed agent (k8s) comparison</summary>",
            "",
            "_No run found for this PR by the deployed agent._",
            "",
            "</details>",
            "",
        ];
    }
    const body = [`- **job status:** ${deployed.jobStatus ?? "?"}`];
    if (deployed.analysisReasoning != null) body.push(`- **analysis:** ${deployed.analysisReasoning}`);
    if (deployed.resolutionReasoning != null) body.push(`- **resolution:** ${deployed.resolutionReasoning}`);
    if (deployed.failureReason != null) body.push(`- **failure:** ${deployed.failureReason}`);
    if (deployed.perTest.length > 0) {
        body.push("", "| test | flagged | ran | fix |", "|---|---|---|---|");
        for (const test of deployed.perTest) {
            const ran = test.runStatus != null ? test.runStatus : "not run";
            body.push(
                `| \`${test.testSlug}\` | ${test.affectedReason ?? "-"} | ${ran} | ${test.generatedFix ? "yes" : "no"} |`,
            );
        }
    }
    return ["<details>", "<summary>Deployed agent (k8s) comparison</summary>", "", ...body, "", "</details>", ""];
}

/** Render the full investigation report as markdown - bugs first (UI-emulating), supplementary detail collapsed. */
export function buildReportMarkdown(input: InvestigationReportInput): string {
    const sections: string[] = [`# ${input.client} · PR #${input.prNumber} (\`${input.appSlug}\`)`, ""];
    for (const test of input.tests) {
        sections.push(...renderTest(test));
    }
    sections.push(...renderSuggestedTests(input.suggested));
    sections.push(...renderQuarantine(input.quarantine));
    sections.push(...renderPrSection(input));
    sections.push(...renderDeployedComparison(input.deployed));
    return sections.join("\n");
}
