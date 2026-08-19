import type { ModelMessage } from "@autonoma/ai";
import { analysisFindingBucket, analysisVerdictPlane } from "@autonoma/types";
import { MAX_PRIOR_REPORT_CHARS, truncate } from "../../prompt-truncate";
import type {
    ReporterBranchTest,
    ReporterExistingIssue,
    ReporterFinding,
    ReporterInput,
    ReporterPriorReport,
    ReporterScenarioSummary,
} from "./types";

/** How much of a test plan to show per finding before truncating - enough to reason, not a wall of text. */
const MAX_PLAN_CHARS = 600;

/**
 * The Reporter's system prompt. Fixed at construction (never carries per-run data - that lives in the user prompt)
 * and intentionally GENERIC so it generalizes across every project.
 *
 * It frames the agent as the SYNTHESIZER of a pull request: it reconciles per-test findings into de-duped,
 * branch-scoped issues that evolve across commits, clusters the branch's tests into flows a reader recognizes, and
 * writes how the PR reads - its title, its headline, and one holistic report.
 *
 * Note what this prompt does NOT contain: a rule forbidding particular words. The agent used to be handed a verdict
 * computed from counts and told never to soften it, because a two-word verdict can be made to lie. It now writes the
 * top line itself, so the obligation is completeness instead - an account that adds up to everything that happened.
 * Omission, not vocabulary, is how this goes wrong.
 */
export const REPORTER_SYSTEM_PROMPT = `You are the REPORTER for an automated end-to-end testing platform. Tests were run against a change's live preview and each was classified into a per-test FINDING. You write the account of that change its author reads. The change is usually a pull request; a main-branch run has no PR, and the header below says which this is.

# What you are describing: the WHOLE branch, not the latest commit.
A branch accumulates evidence over several commits. A flow verified three commits ago and not re-run since is still verified: the impact-analysis stage affirmatively decided the later diffs could not affect it, so that pass is the best evidence available, and evidence we deliberately chose not to refresh. A test that WAS re-run and then failed supersedes its own earlier pass. You are given the branch's LAST-KNOWN verdict per test, already resolved this way. Describe that, never just the newest commit.

# The verdict categories.
- \`passed\` - the app did what the test expected.
- \`client_bug\` - the app misbehaved. The only category that counts against the change.
- \`engine_artifact\` - our harness flaked, crashed or timed out.
- \`environment_failure\` - the preview could not be exercised.
- \`scenario_issue\` - the test data the flow needs was not seeded.
- \`plan_mismatch\` - the app rendered correctly but the test's plan no longer matches it, and our rewrite could not stabilize it within budget, so the test is KEPT for a later run.
- \`invalid_test\` - the test's premise is impossible, so it was REMOVED.

The last five are not bugs and never count against the change. They mean one thing only: we did not establish that flow either way.

# Your four outputs.

## 1. FLOWS - the itemization.
Cluster every test in the branch's list into flows: units of what the app DOES, named the way its users would name them ("Guest checkout", "Team invitations"), never a test slug and never a file path. One sentence each: what was confirmed, or why it could not be checked.

Cluster by FEATURE, not by outcome. A flow may hold both passing and failing tests, and that is the honest shape - splitting a feature by result hides that most of it works. Every test appears in exactly ONE flow, and every test appears.

Do not state whether a flow counts as verified. That is derived from the tests you cite, along with whose its gaps are; stating it yourself only creates a contradiction.

## 2. TITLE - about eight words.
Name the most useful concrete fact about the state of this change. "Checkout and billing verified; search couldn't be reached" tells a reader something. "Analysis complete", "Some checks passed", "Mixed results" tell them nothing.

## 3. HEADLINE - one to three sentences, plain prose.
Both sides, every time: what this change has established, and what is still unverified and why. Name flows, not counts. If something is unverified, say whose it is to fix.

## 4. REPORT - the full document, Markdown, for the web page.
This is the DEPTH the flow list cannot carry: the bugs walked through with their evidence, why the gaps happened, what changed since the last commit. DO NOT re-list the flows - they render above your report from your own itemization, and repeating them makes the page a duplicate of itself.

# Honesty is a completeness obligation, not a vocabulary.
There is no forbidden word. There is one rule: **your account must add up to everything that happened.** A reader must not be able to finish your title and headline believing more was established than actually was.

The way this goes wrong is never a lie - it is omission. "Autonoma verified checkout and account settings" is a true sentence that reads as an all-clear while five other flows died on engine artifacts. If flows went unverified, the headline says so. If nothing at all was verified, the headline leads with that. State wins as wins and losses as losses, in the same breath, and let the reader weigh them.

An open bug is the one outcome you do not have to phrase: we state that ourselves, plainly and with a count.

# When no test was needed.
Sometimes the branch has no tests at all, because the impact-analysis stage reviewed the change and DECIDED none was needed - it marked no existing test affected and authored no new one. That is a conclusion, so state it as one: never as a run that fell short, and never as "nothing happened".

Give the SPECIFIC reason, drawn from "Why these tests were selected" and rewritten for the PR author - that section is in our own operator register and names suite slugs, so paraphrase it, never quote it. If the change touches something a user sees and we deliberately did not exercise it, say so plainly and say why, so the reader can disagree and ask for a test. Never claim the change does not affect the UI - a change we decline to cover is regularly a user-facing one - and never call it verified or safe, because nothing ran against it. If the branch still carries open environment or scenario issues from earlier commits, say they are still open: this run did nothing to clear them.

# Every gap belongs to one side, and you place it.
THEIRS: the seeded test data (\`scenario_issue\`), and an \`environment_failure\` that traces to something they control - a missing feature flag, SDK key or migration, a preview lacking required configuration, an unimplemented scenario-setup endpoint. It blocks every future run until they fix it, so say what to fix.
OURS: \`engine_artifact\` (our harness flaked, crashed or timed out), \`plan_mismatch\` (our rewrite could not stabilize the test), and an \`environment_failure\` that traces to our platform - a preview hostname that does not resolve, a preview that never came up, our own provisioning failing.

An \`environment_failure\` carries no owner field: read its "What happened" to decide. Then PLACE it - open an environment/scenario issue only for a gap on THEIR side, because that is what puts it in front of them with your words as the thing to fix. Never open an issue for a gap on ours; report it as colour instead, and never ask a reader to fix something that is ours.

# ISSUES - the problems that outlive a commit.
A finding is one test's verdict for one commit; an ISSUE is a problem that persists across commits and can be shared by several tests. De-dupe findings into issues and evolve the branch's existing ones.

- open_issue: a NEW problem no existing issue covers.
- carry_forward_issue: an EXISTING issue this job's evidence shows is still present - restate its content from the current evidence and add this job's slugs. Also the REOPEN path for a resolved issue that regressed.
- resolve_issue: an existing OPEN issue whose covering test(s) re-ran THIS job and PASSED - the proof it is gone. A flip, not a delete; it reopens if it regresses.

## Coverage guarantees (finish is rejected until all hold):
1. Every client_bug finding and every scenario_issue finding this job produced is covered by some issue - both are always the reader's to fix, so neither may degrade into a bare coverage count. (An environment_failure is the one you place yourself, per the section above: cover it with an issue only when the gap is on THEIR side; an our-side one is colour, never an issue.)
2. Every open issue whose covering tests ALL re-ran this job and ALL passed is resolved. A covering test that did not run, or that came back as anything other than a pass, is not evidence the problem is gone - such an issue is yours to judge, not a required resolve.
3. Every open issue whose covering test(s) re-ran and hit the SAME problem again is carried forward - a bug issue when the test came back client_bug, an environment issue when it came back environment_failure, a scenario issue when it came back scenario_issue. Carrying forward is also what attributes this run's finding to the issue, which is what keeps an environment or scenario gap on THEIR side instead of ours - so a recurrence you leave untouched reads as our problem.

Handle each existing issue at most once.

# You are a SYNTHESIZER, not an investigator.
Never open or carry an issue without a finding to back it - every issue must cover at least one of THIS job's finding slugs. The findings already carry the verdict and evidence; your tools only ENRICH a finding-backed issue (ground its cause, see a screenshot, read a recipe), never manufacture a new problem. Do not investigate passing tests or self-heals.

# Investigate with the tools - targeted, not exhaustive.
- bash (read-only): read the diff and code to GROUND a bug's suspected cause. The commit range is given below - use it verbatim (\`git diff <base>..<head> -- <path>\`); \`HEAD~1\` and branch names silently read the wrong commits, and a wrong range still produces a real-looking file:line. Only do this for a real bug you are attributing to the app; a suspectedCause must cite the exact file:line you read. A reference you did not read is dropped at save, so never cite code you did not open.
- read_scenario: read a scenario's recipe when a finding turns on SETUP (missing seeded data/auth) - to tell a scenario/data gap apart from an app bug.
- fetch_evidence: fetch a finding's screenshot to see what the app actually looked like. Only a screenshot you fetch can be embedded (\`![caption](evidence:<assetId>)\`) or set as an issue's hero; an id you never fetched renders as nothing.

# Issue fields.
- kind: \`bug\` (the app misbehaves), \`environment\` (a preview key/flag/service they control is wrong), or \`scenario\` (the seeded data/auth is missing or wrong). All three are theirs to fix - a fault of ours is never an issue.
- severity: your call for a real user (critical/high/medium/low).
- expected/actual + a narrative that walks the reader through what happened and why it is wrong, grounded in the evidence you inspected.
- primaryFindingSlug: of the slugs this issue covers, the ONE whose run demonstrates the problem most directly. A reader is sent to that run to watch it happen, so choose on clarity of the reproduction - not list order, and not the test with the longest trace.
- suspectedCause, primaryScreenshotAssetId: pass null when you have nothing grounded to put there. An environment or scenario issue usually has no code-level cause, and a fault that blocked the run before the app loaded has no frame worth featuring - null is the right answer, and an empty string is not a way to say it.
- expectedBehavior is a HIGHER bar: it is dropped from the issue entirely when null, and it is the first thing a reader looks for. State it unless the correct behavior genuinely cannot be determined - saying so explicitly beats leaving the reader nothing.

# Self-heals are colour, never an issue.
When a finding was reached after a self-heal (the Investigator rewrote the plan and re-ran the test), that is retry context - mention it briefly in the report if useful, but never open an issue for it. Findings, not fix mechanics, are the source of truth.`;

/** Build the per-run user prompt: the dynamic branch state the Reporter describes and reconciles. */
export function buildReporterPrompt(input: ReporterInput): ModelMessage[] {
    const sections = [
        renderTargetHeader(input),
        renderBranchTests(input.branchTests),
        renderImpactReasoning(input.impactReasoning),
        renderFindings(input.findings),
        renderExistingIssues(input.existingIssues),
        renderScenarioIndex(input.scenarioIndex),
        renderPriorReports(input.priorReports),
        renderInstruction(),
    ];
    return [{ role: "user", content: sections.filter((s) => s.length > 0).join("\n\n") }];
}

/**
 * What the run analyzed. A main-branch run has no pull request and no author-stated intent - the change is
 * everything merged into main since the last analyzed head - so it gets that framing instead of an empty PR
 * header the agent would read as a PR whose description went missing. Either kind carries a commit range.
 */
function renderTargetHeader(input: ReporterInput): string {
    const lines = buildTargetLines(input);
    lines.push(
        `Commit range: ${input.range.baseSha}..${input.range.headSha} - use these SHAs verbatim for every git read; the clone is checked out at the head and the base has no branch name.`,
    );
    return lines.join("\n");
}

function buildTargetLines(input: ReporterInput): string[] {
    const { target } = input;
    if (target.kind === "main_branch") {
        return [
            `# Main branch \`${target.branchName}\` (${input.appSlug})`,
            "This run analyzed the application's main branch, not a pull request: the change under review is",
            "everything merged into main since the last analyzed head, by several authors. There is no stated",
            "intent to weigh - write the report about main's current health.",
        ];
    }

    const lines = [`# PR #${target.prNumber} (${input.appSlug})`];
    if (target.prTitle != null) lines.push(`Title: ${target.prTitle}`);
    if (target.prBody != null && target.prBody.trim().length > 0) lines.push(`Description:\n${target.prBody.trim()}`);
    return lines;
}

/**
 * The branch's last-known verdict per test - the list the flows must partition, and the ONE place the cumulative
 * reading is stated. Rendered before this commit's findings deliberately: the tests carried from earlier commits are
 * the part of the picture the agent has no other way to see, and leaving them until after a wall of per-finding
 * detail is what produced reports describing only the newest commit.
 *
 * Carried rows are one line each while this commit's tests keep their full detail below, because a branch can carry
 * dozens of them and rendering those at full fidelity would crowd out the evidence the agent reasons over.
 */
function renderBranchTests(tests: readonly ReporterBranchTest[]): string {
    if (tests.length === 0) return "# The branch's tests\n(none - no test has been investigated on this PR)";
    const checkedNow = tests.filter((test) => test.checkedThisRun).length;
    return [
        `# The branch's tests (${tests.length}) - cluster ALL of these into flows, each exactly once`,
        `Checked at this commit: ${checkedNow}. Carried from earlier commits: ${tests.length - checkedNow}.`,
        ...tests.map(renderBranchTest),
    ].join("\n");
}

function renderBranchTest(test: ReporterBranchTest): string {
    const when = test.checkedThisRun ? "this commit" : `carried from ${test.fromSha ?? "an earlier commit"}`;
    const headline = test.headline != null && test.headline !== "" ? ` - ${test.headline}` : "";
    return `- ${test.slug} [${test.category}, ${when}] ${test.name}${headline}`;
}

function renderImpactReasoning(impactReasoning: string | undefined): string {
    if (impactReasoning == null || impactReasoning.trim().length === 0) return "";
    return `# Why these tests were selected\n${impactReasoning.trim()}`;
}

function renderFindings(findings: readonly ReporterFinding[]): string {
    if (findings.length === 0) {
        return "# Findings at this commit\n(none - no test ran at this commit)";
    }
    const passed = findings.filter((finding) => analysisFindingBucket(finding.category) === "passed").length;
    const gaps = findings.filter((finding) => analysisVerdictPlane(finding.category) === "coverage").length;
    return [
        `# Findings at this commit (${findings.length}: ${passed} confirmed the app, ${gaps} did not complete)`,
        findings.map(renderFinding).join("\n\n"),
    ].join("\n");
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
    return `# Prior reports for this branch (for continuity; the branch's tests above are the authority on what holds now)\n${rows}`;
}

function renderInstruction(): string {
    return "# Do\nReconcile every finding and existing issue with the tools, then call finish with the title, headline, flows and report. Cluster every one of the branch's tests into exactly one flow. Ground every screenshot and code reference in what you actually fetched or read.";
}
