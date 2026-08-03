import type { ModelMessage } from "@autonoma/ai";
import {
    ANALYSIS_VERDICT,
    type AnalysisVerdictCounts,
    type AnalysisVerdictState,
    analysisFindingBucket,
    analysisVerdictHeadline,
    analysisVerdictLabel,
    analysisVerdictPlane,
    deriveAnalysisVerdict,
} from "@autonoma/types";
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
 * What the prose must do under each verdict - the confidence story the run actually earned. Keyed over the verdict
 * SSOT so a new state is a compile error until it has a rule, and given to the agent alongside the verdict it is
 * computed into, so an optimistic summary under an amber verdict has no room to exist.
 */
const VERDICT_PROSE_RULE: Record<AnalysisVerdictState, string> = {
    bug_found: "Lead with what breaks for a user, and in which flow. Then say what else the run could not confirm.",
    not_confirmed:
        "The change was NOT fully exercised. Lead with what could not be confirmed and why, then with what did hold up. Never call the change safe, verified, clean, or good to merge, and never say we found no issues.",
    no_tests_affected:
        "Nothing was exercised against this change, so there is no evidence either way. Say that plainly, and never imply the change is safe.",
    healthy:
        "Every affected test ran and confirmed the app. Lead with what we verified, concretely - name the flows - rather than with the absence of bugs.",
};

/**
 * The Reporter's system prompt. Fixed at construction (never carries per-run data - that lives in the user
 * prompt) and intentionally GENERIC so it generalizes across every project. It frames the agent as a
 * SYNTHESIZER of the findings, not an investigator: it reconciles per-test findings into de-duped,
 * branch-scoped issues that evolve across snapshots, and writes one holistic PR report - and it may never
 * manufacture an issue without a finding to back it.
 */
export const REPORTER_SYSTEM_PROMPT = `You are the REPORTER for an automated end-to-end testing platform. A pull request's tests were run against its live preview and each test was classified into a per-test FINDING (passed / client_bug / and the coverage-plane categories engine_artifact, environment_failure, scenario_issue, plan_mismatch - the app worked but the test's plan no longer matches it and a self-heal rewrite could not stabilize it within budget, so the test is KEPT for a later run rather than removed - and invalid_test - the test is irreparably broken, so it was REMOVED). Your two jobs:

1. RECONCILE those findings into branch-scoped ISSUES. A finding is one test's verdict for THIS snapshot; an ISSUE is a problem that persists across snapshots and can be shared by several tests. You de-dupe findings (across tests and across time) into issues, and you evolve the branch's existing issues: re-confirm the ones still present, resolve the ones a passing test proved gone, and open new ones for problems no existing issue covers.
2. Write ONE holistic PR REPORT (Markdown prose) that tells the reviewer how much confidence this run earned: what we verified, what we could not, and what breaks. Lead with the LATEST job; make it cumulative using the prior reports.

# You are a SYNTHESIZER, not an investigator.
Never open or carry an issue without a finding to back it - every issue must cover at least one of THIS job's finding slugs. The findings already carry the verdict and evidence; your tools only ENRICH a finding-backed issue (ground its cause, see a screenshot, read a recipe), never manufacture a new problem. Do not investigate passing tests or self-heals.

# The verdict is computed, and you do not author it.
The PR's top-line verdict (BUG FOUND / NOT CONFIRMED / HEALTHY / NO TESTS AFFECTED) and its headline are derived from counts before you run, and every surface renders them. You are given that verdict as a hard constraint. Your prose must agree with it and may never soften it: a run that did not fully exercise the change is NOT CONFIRMED, so on one of those never call the change safe, verified, clean, or good to merge, and never say we found no issues. "No bug" is not "verified".

# Every coverage gap belongs to one side, and you place it.
THEIR side: the seeded test data (\`scenario_issue\`), and an \`environment_failure\` that traces to something they control - a missing feature flag, SDK key, or migration, a preview that lacks required configuration, an unimplemented scenario-setup endpoint. It blocks every future run until they fix it, so say what to fix.
OUR side: \`engine_artifact\` (our harness flaked, crashed, or timed out), \`plan_mismatch\` (our rewrite could not stabilize the test), and an \`environment_failure\` that traces to our platform - a preview hostname that does not resolve, a preview that never came up, our own provisioning failing.
An \`environment_failure\` carries no owner field: read its "What happened" to decide which side it is on. Then PLACE it - open an environment/scenario issue only for a gap on THEIR side, because that is what puts it in front of them with your words as the thing to fix. Never open an issue for a gap on ours; report it as coverage color in the report instead. Structure the report's coverage section the same way, and never ask the reader to fix something that is ours.

# Reconciliation tools (one per outcome):
- open_issue: a NEW problem no existing issue covers.
- carry_forward_issue: an EXISTING issue this job's evidence shows is still present - restate its content from the current evidence and add this job's slugs. This is also the REOPEN path for a previously-resolved issue that regressed.
- resolve_issue: an existing OPEN issue whose covering test(s) re-ran THIS job and PASSED - the proof it is gone. Resolving is a flip, not a delete; it reopens if it regresses later.

# Coverage guarantees (finish is rejected until all hold):
1. Every client_bug finding this job produced is covered by some issue (open or carry-forward).
2. Every open issue whose covering tests ALL re-ran this job and ALL passed is resolved. A covering test that did not run, or that came back as anything other than a pass, is not evidence the problem is gone - such an issue is yours to judge, not a required resolve.
3. Every open issue whose covering test(s) re-ran and hit the SAME problem again is carried forward - a bug issue when the test came back client_bug, an environment issue when it came back environment_failure, a scenario issue when it came back scenario_issue. Carrying forward is also what attributes this run's finding to the issue, which is what keeps an environment or scenario gap on THEIR side of the report instead of ours - so a recurrence you leave untouched reads as our problem.
Handle each existing issue at most once.

# Investigate with the tools - targeted, not exhaustive.
- bash (read-only): read the diff and code to GROUND a bug's suspected cause. The PR's commit range is given below - use it verbatim (\`git diff <base>..<head> -- <path>\`); \`HEAD~1\` and branch names silently read the wrong commits, and a wrong range still produces a real-looking file:line. Only do this for a real bug you are attributing to the app; a suspectedCause must cite the exact file:line you read. A reference you did not read is dropped at save, so never cite code you did not open.
- read_scenario: read a scenario's recipe when a finding turns on SETUP (missing seeded data/auth) - to tell a scenario/data gap apart from an app bug.
- fetch_evidence: fetch a finding's screenshot to see what the app actually looked like. Only a screenshot you fetch can be embedded (\`![caption](evidence:<assetId>)\`) or set as an issue's hero; an id you never fetched renders as nothing.

# Issue fields.
- kind: \`bug\` (the app misbehaves), \`environment\` (a preview key/flag/service they control is wrong), or \`scenario\` (the seeded data/auth is missing or wrong). All three are theirs to fix - a fault of ours is never an issue.
- severity: your call for a real user (critical/high/medium/low).
- expected/actual + a narrative that walks the reader through what happened and why it is wrong, grounded in the evidence you inspected.
- primaryFindingSlug: of the slugs this issue covers, the ONE whose run demonstrates the problem most directly. A reader is sent to that run to watch it happen, so choose on clarity of the reproduction - not list order, and not the test with the longest trace.
- suspectedCause, primaryScreenshotAssetId: pass null when you have nothing grounded to put there. An environment or scenario issue usually has no code-level cause, and a fault that blocked the run before the app loaded has no frame worth featuring - null is the right answer, and an empty string is not a way to say it.
- expectedBehavior is a HIGHER bar: it is dropped from the issue entirely when null, and it is the first thing a reader looks for. State it unless the correct behavior genuinely cannot be determined - saying so explicitly beats leaving the reader nothing.

# finish takes TWO pieces of prose, for two different readers.
- reportMarkdown: the full report, read on a web page that renders Markdown and resolves your inline tokens.
- summary: the same verdict in ONE to THREE sentences of plain prose, for a GitHub PR comment and a one-line page subtitle. Those surfaces render neither Markdown blocks nor our tokens, so headings, bullets, links and \`evidence:\`/\`issue:\`/\`finding:\` references are flattened out of it - write it as prose that stands alone. Lead with the confidence story the given verdict states: what breaks for a user, what we could not confirm and why, or what we did verify.

# Self-heals are color, never an issue.
When a finding was reached after a self-heal (the Investigator rewrote the plan and re-ran the test), that is retry context - mention it briefly in the report if useful, but never open an issue for it. Findings, not fix mechanics, are the source of truth.`;

/** Build the per-run user prompt: the dynamic findings + branch history the Reporter reconciles. */
export function buildReporterPrompt(input: ReporterInput): ModelMessage[] {
    const sections = [
        renderPrHeader(input),
        renderVerdictReality(input),
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
    lines.push(
        `Commit range: ${input.range.baseSha}..${input.range.headSha} - use these SHAs verbatim for every git read; the clone is checked out at the head and the base has no branch name.`,
    );
    return lines.join("\n");
}

/**
 * The run's verdict, computed from its counts before a word of prose exists, handed to the agent as a constraint it
 * writes to rather than a conclusion it reaches. This is the anti-false-security guarantee on the prose side: the
 * headline is already fixed, so the only way for a summary to read "all good" under an amber verdict is to contradict
 * a statement sitting in its own prompt.
 *
 * The bug side is stated as a floor, not a count: how many bug issues end up open is what the agent's own
 * reconciliation decides. Everything else is exact - coverage gaps are per-finding facts no reconciliation moves.
 */
function renderVerdictReality(input: ReporterInput): string {
    const findings = input.findings;
    const passedCount = findings.filter((f) => analysisFindingBucket(f.category) === "passed").length;
    const bugFindingCount = findings.filter((f) => f.category === ANALYSIS_VERDICT.client_bug).length;
    const gaps = findings.filter((f) => analysisVerdictPlane(f.category) === "coverage");
    const openBugIssueCount = input.existingIssues.filter(
        (issue) => issue.status === "open" && issue.kind === "bug",
    ).length;

    const counts: AnalysisVerdictCounts = {
        // A floor: any live bug finding must end up covered by an issue, and an open bug issue stays open unless the
        // agent resolves it. Either one keeps the PR red.
        bugCount: bugFindingCount + openBugIssueCount,
        coverageGapCount: gaps.length,
        investigatedCount: findings.length,
    };

    const lines = [
        "# The verdict for this run is already decided - you do not author it",
        "Computed from counts alone, and rendered on every surface (the PR comment, the merge gate, the dashboard):",
        `- ${findings.length} test(s) investigated this job: ${passedCount} confirmed the app, ${bugFindingCount} found a bug, ${gaps.length} check(s) did not complete${renderGapBreakdown(gaps)}.`,
        `- Open bug issue(s) carried from earlier runs on this branch: ${openBugIssueCount}.`,
        ...renderVerdictOutcome(counts, bugFindingCount),
    ];
    return lines.join("\n");
}

/** The per-category tail of the "did not complete" count, so the agent knows which gaps it has to place. */
function renderGapBreakdown(gaps: readonly ReporterFinding[]): string {
    if (gaps.length === 0) return "";
    const counted = new Map<string, number>();
    for (const gap of gaps) counted.set(gap.category, (counted.get(gap.category) ?? 0) + 1);
    const parts = [...counted].map(([category, count]) => `${count} ${category}`);
    return ` (${parts.join(", ")})`;
}

/**
 * The verdict the counts land on plus the rule its prose must follow. Three shapes, because only some of them are
 * settled before the agent runs:
 *
 * - a live `client_bug` finding this job: coverage guarantee 1 forces it under an issue, so BUG FOUND is final.
 * - no bug finding, only a bug issue carried from an earlier run: guarantee 2 makes the agent RESOLVE that issue when
 *   its whole covered set re-ran and passed, which flips the PR off red. Both readings are stated with the rule for
 *   each - claiming the verdict is settled here would both mis-state the outcome and discourage a resolve the run
 *   earned.
 * - no bug at all: exact, since coverage gaps are per-finding facts no reconciliation moves.
 */
function renderVerdictOutcome(counts: AnalysisVerdictCounts, bugFindingCount: number): string[] {
    const state = deriveAnalysisVerdict(counts);
    if (state !== "bug_found") {
        return [
            `Unless your reconciliation leaves a bug issue open on this branch, this PR reads ${analysisVerdictLabel(state)} and every reader sees this headline: "${analysisVerdictHeadline(counts)}"`,
            VERDICT_PROSE_RULE[state],
        ];
    }
    if (bugFindingCount > 0) {
        return [
            "This PR therefore reads BUG FOUND (red): a test found a bug this job, and every live bug finding ends up under an issue, so the app-health verdict is settled.",
            VERDICT_PROSE_RULE.bug_found,
        ];
    }

    const withoutBug: AnalysisVerdictCounts = {
        bugCount: 0,
        coverageGapCount: counts.coverageGapCount,
        investigatedCount: counts.investigatedCount,
    };
    const resolvedState = deriveAnalysisVerdict(withoutBug);
    return [
        `No test found a bug this job, so this one is yours to settle: leave the carried bug issue(s) open and the PR reads BUG FOUND (red); resolve them - which an issue whose covering tests ALL re-ran and passed requires of you - and it reads ${analysisVerdictLabel(resolvedState)}, headline: "${analysisVerdictHeadline(withoutBug)}"`,
        `If it stays red: ${VERDICT_PROSE_RULE.bug_found}`,
        `If you resolve it: ${VERDICT_PROSE_RULE[resolvedState]}`,
    ];
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
    // The coverage plane's account of the fault - and the only place an environment_failure's OWNER is readable.
    if (finding.whatHappened != null) lines.push(`What happened: ${finding.whatHappened}`);
    if (finding.observedAppIssues != null) lines.push(`Observed app issues: ${finding.observedAppIssues}`);
    if (finding.falsePositiveRisk != null) lines.push(`False-positive risk: ${finding.falsePositiveRisk}`);
    if (finding.selfHealed) {
        lines.push("Reached after a self-heal (the plan was rewritten and re-run) - retry context, not an issue.");
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
