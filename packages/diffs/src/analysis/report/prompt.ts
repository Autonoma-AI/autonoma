import type { ModelMessage } from "ai";
import type {
    ReporterExistingIssue,
    ReporterFinding,
    ReporterInput,
    ReporterPriorReport,
    ReporterScenarioSummary,
} from "./types";

/** How much of a test plan to show per finding before truncating - enough to reason, not a wall of text. */
const MAX_PLAN_CHARS = 600;
/** How much of a prior report to carry as context before truncating. */
const MAX_PRIOR_REPORT_CHARS = 2_000;

/**
 * The Reporter's system prompt. Fixed at construction (never carries per-run data - that lives in the user
 * prompt) and intentionally GENERIC so it generalizes across every project. It frames the agent as a
 * SYNTHESIZER of the findings, not an investigator: it reconciles per-test findings into de-duped,
 * branch-scoped issues that evolve across snapshots, and writes one holistic PR report - and it may never
 * manufacture an issue without a finding to back it.
 */
export const REPORTER_SYSTEM_PROMPT = `You are the REPORTER for an automated end-to-end testing platform. A pull request's tests were run against its live preview and each test was classified into a per-test FINDING (passed / client_bug / and the coverage-plane categories engine_artifact, environment_failure, scenario_issue, delete). Your two jobs:

1. RECONCILE those findings into branch-scoped ISSUES. A finding is one test's verdict for THIS snapshot; an ISSUE is a problem that persists across snapshots and can be shared by several tests. You de-dupe findings (across tests and across time) into issues, and you evolve the branch's existing issues: re-confirm the ones still present, resolve the ones a passing test proved gone, and open new ones for problems no existing issue covers.
2. Write ONE holistic PR REPORT (Markdown prose) that tells the reviewer what this PR does and what the run found - open bugs first (the headline), then environment/scenario/coverage color, then a brief note on any self-heals. Lead with the LATEST job; make it cumulative using the prior reports.

# You are a SYNTHESIZER, not an investigator.
Never open or carry an issue without a finding to back it - every issue must cover at least one of THIS job's finding slugs. The findings already carry the verdict and evidence; your tools only ENRICH a finding-backed issue (ground its cause, see a screenshot, read a recipe), never manufacture a new problem. Do not investigate passing tests or self-heals.

# Reconciliation tools (one per outcome):
- open_issue: a NEW problem no existing issue covers.
- carry_forward_issue: an EXISTING issue this job's evidence shows is still present - restate its content from the current evidence and add this job's slugs. This is also the REOPEN path for a previously-resolved issue that regressed.
- resolve_issue: an existing OPEN issue whose covering test(s) re-ran THIS job and PASSED - the proof it is gone. Resolving is a flip, not a delete; it reopens if it regresses later.

# Coverage guarantees (finish is rejected until all hold):
1. Every client_bug finding this job produced is covered by some issue (open or carry-forward).
2. Every open issue whose covering test(s) re-ran and PASSED is resolved.
3. Every open issue whose covering test(s) re-ran and STILL FAILED is carried forward.
Handle each existing issue at most once.

# Investigate with the tools - targeted, not exhaustive.
- bash (read-only): read the diff and code to GROUND a bug's suspected cause (git diff, grep, cat). Only do this for a real bug you are attributing to the app; a suspectedCause must cite the exact file:line you read. A reference you did not read is dropped at save, so never cite code you did not open.
- read_scenario: read a scenario's recipe when a finding turns on SETUP (missing seeded data/auth) - to tell a scenario/data gap apart from an app bug.
- fetch_evidence: fetch a finding's screenshot to see what the app actually looked like. Only a screenshot you fetch can be embedded (\`![caption](evidence:<assetId>)\`) or set as an issue's hero; an id you never fetched renders as nothing.

# Issue fields.
- kind: \`bug\` (the app misbehaves), \`environment\` (a preview key/flag/service is wrong), or \`scenario\` (the seeded data/auth is missing or wrong).
- severity: your call for a real user (critical/high/medium/low).
- expected/actual + a narrative that walks the reader through what happened and why it is wrong, grounded in the evidence you inspected.

# Self-heals are color, never an issue.
When a finding was reached after the Investigator rewrote the plan (planEdited / a self-heal note), that is retry context - mention it briefly in the report if useful, but never open an issue for it. Findings, not fix mechanics, are the source of truth.`;

/** Build the per-run user prompt: the dynamic findings + branch history the Reporter reconciles. */
export function buildReporterPrompt(input: ReporterInput): ModelMessage[] {
    const sections = [
        renderPrHeader(input),
        renderImpactReasoning(input.impactReasoning),
        renderFindings(input.findings),
        renderExistingIssues(input.existingIssues),
        renderScenarioIndex(input.scenarioIndex),
        renderPriorReports(input.priorReports),
        renderInstruction(),
    ];
    return [{ role: "user", content: sections.filter((s) => s.length > 0).join("\n\n") }];
}

function renderPrHeader(input: ReporterInput): string {
    const lines = [`# PR #${input.pr.number} (${input.appSlug})`];
    if (input.pr.title != null) lines.push(`Title: ${input.pr.title}`);
    if (input.pr.body != null && input.pr.body.trim().length > 0) lines.push(`Description:\n${input.pr.body.trim()}`);
    return lines.join("\n");
}

function renderImpactReasoning(impactReasoning: string | undefined): string {
    if (impactReasoning == null || impactReasoning.trim().length === 0) return "";
    return `# Why these tests were selected\n${impactReasoning.trim()}`;
}

function renderFindings(findings: readonly ReporterFinding[]): string {
    if (findings.length === 0) return "# Findings this job\n(none)";
    return `# Findings this job\n${findings.map(renderFinding).join("\n\n")}`;
}

function renderFinding(finding: ReporterFinding): string {
    const lines = [`## ${finding.slug} - ${finding.category}`, finding.headline];
    if (finding.expectedBehavior != null) lines.push(`Expected: ${finding.expectedBehavior}`);
    if (finding.actualBehavior != null) lines.push(`Actual: ${finding.actualBehavior}`);
    if (finding.observedAppIssues != null) lines.push(`Observed app issues: ${finding.observedAppIssues}`);
    if (finding.falsePositiveRisk != null) lines.push(`False-positive risk: ${finding.falsePositiveRisk}`);
    if (finding.planEdited) {
        const note = finding.selfHealNote != null ? ` (${finding.selfHealNote})` : "";
        lines.push(`Reached after a self-heal (plan was edited)${note} - retry context, not an issue.`);
    }
    if (finding.plan != null) lines.push(`Plan: ${truncate(finding.plan, MAX_PLAN_CHARS)}`);
    for (const evidence of finding.codeEvidence ?? []) {
        const where =
            evidence.file != null ? ` [${evidence.file}${evidence.lines != null ? `:${evidence.lines}` : ""}]` : "";
        lines.push(`Evidence (${evidence.source})${where}: ${evidence.detail}`);
    }
    if (finding.screenshots.length > 0) {
        const shots = finding.screenshots.map((s) => `${s.assetId} (${s.label})`).join(", ");
        lines.push(`Fetchable screenshots: ${shots}`);
    }
    return lines.join("\n");
}

function renderExistingIssues(issues: readonly ReporterExistingIssue[]): string {
    if (issues.length === 0)
        return "# Existing issues\n(none - this is the first report for the branch, or none are open)";
    return `# Existing issues (reconcile each)\n${issues.map(renderExistingIssue).join("\n\n")}`;
}

function renderExistingIssue(issue: ReporterExistingIssue): string {
    const lines = [
        `## ${issue.id} [${issue.status}] ${issue.kind}/${issue.severity} - ${issue.title}`,
        `Expected: ${issue.expectedBehavior ?? "(none stated)"}`,
        `Actual: ${issue.actualBehavior}`,
        `Covers tests: ${issue.findingSlugs.join(", ")}`,
    ];
    if (issue.narrativeSummary != null) lines.push(`Summary: ${issue.narrativeSummary}`);
    return lines.join("\n");
}

function renderScenarioIndex(scenarios: readonly ReporterScenarioSummary[]): string {
    if (scenarios.length === 0) return "";
    const rows = scenarios.map((s) => `- ${s.id}: ${s.name} - ${s.summary}`).join("\n");
    return `# Scenario index (read a full recipe with read_scenario when a finding turns on setup)\n${rows}`;
}

function renderPriorReports(priorReports: readonly ReporterPriorReport[]): string {
    if (priorReports.length === 0) return "";
    const rows = priorReports
        .map((r) => `## Report for ${r.snapshotId}\n${truncate(r.reportMarkdown, MAX_PRIOR_REPORT_CHARS)}`)
        .join("\n\n");
    return `# Prior reports for this branch (make yours cumulative; lead with the latest job)\n${rows}`;
}

function renderInstruction(): string {
    return "# Do\nReconcile every finding and existing issue with the tools, then call finish with the holistic report. Ground every screenshot and code reference in what you actually fetched/read.";
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}...[truncated]`;
}
