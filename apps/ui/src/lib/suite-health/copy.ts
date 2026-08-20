import type { SuiteHealth, SuiteHealthDriver, SuiteHealthLevel } from "@autonoma/types";
import { WAITING_FOR_FIRST_PULL_REQUEST } from "lib/zero-state/copy";

/**
 * The paragraph for a suite that has never run, which every level's own `body` gets wrong by describing a
 * process that has not begun. Read through `suiteHealthBody` rather than directly.
 */
const NEVER_RUN_BODY =
    "The agent wrote these tests by reading your code. It has never operated your app, so nothing here is proven or disproven yet. Your first pull request is what starts that.";

interface SuiteHealthPresentation {
    label: string;
    /** The tooltip's paragraph. Read it through `suiteHealthBody`, which handles the never-run case. */
    body: string;
    /** Tailwind classes for the lit bars, the pill and the header dot at this level. */
    bar: string;
    pill: string;
    dot: string;
}

export const SUITE_HEALTH_PRESENTATION: Record<SuiteHealthLevel, SuiteHealthPresentation> = {
    degraded: {
        label: "Degraded",
        body: "Runs keep failing and nothing has been triaged, so the agent can no longer tell a real bug from a stale test. Clear the open failures to bring it back.",
        bar: "bg-status-critical",
        pill: "border-status-critical/50 bg-status-critical/10 text-status-critical",
        dot: "bg-status-critical",
    },
    at_risk: {
        label: "At risk",
        body: "Several tests fail intermittently. Every failure you clear - in the app, the preview or the test data - teaches the agent what to keep, and a handful usually moves this back up.",
        bar: "bg-status-high",
        pill: "border-status-high/50 bg-status-high/10 text-status-high",
        dot: "bg-status-high",
    },
    calibrating: {
        label: "Calibrating",
        body: "Your suite is new, so it is not proven yet. Every app starts here: the agent wrote these tests from one pass over your app and now needs real pull requests to learn which ones matter and to self-heal the ones that drift.",
        bar: "bg-status-warn",
        pill: "border-status-warn/50 bg-status-warn/10 text-status-warn",
        dot: "bg-status-warn",
    },
    steady: {
        label: "Steady",
        body: "The suite has survived enough merges that the agent self-heals selector drift without asking. Failures you see now are much more likely to be real bugs.",
        bar: "bg-primary-ink",
        pill: "border-primary-ink/50 bg-primary-ink/10 text-primary-ink",
        dot: "bg-primary-ink",
    },
    proven: {
        label: "Proven",
        body: "Weeks of green runs and merged pull requests behind it. When a test fails at this level, treat it as a bug in the code, not in the test.",
        bar: "bg-status-success",
        pill: "border-status-success/50 bg-status-success/10 text-status-success",
        dot: "bg-status-success",
    },
};

export const SUITE_HEALTH_RAISES = [
    "Tests that pass when the agent checks a pull request",
    "The agent self-healing a test inside a PR",
    "A flagged bug fixed before the PR merges",
];

export const SUITE_HEALTH_LOWERS = [
    "Failures left unresolved for days",
    "Tests that flake more often than they pass",
    "Preview environments or test data that keep failing",
];

/**
 * The one thing costing this suite the most. Two suites at the same level routinely need opposite things done, so
 * the level alone is not actionable: one should keep shipping pull requests until its tests converge, the other
 * should go fix its preview environment.
 */
const DRIVER_NOTES: Record<SuiteHealthDriver, string | undefined> = {
    environment: "Most of what is failing is the preview environment, not your tests. Fixing it is the fastest way up.",
    scenario: "Most of what is failing is test data, not your app. Fixing the scenario recipe is the fastest way up.",
    plan: "Your environment and test data are solid. What is left is tests that do not match the app yet, and more pull requests converge them.",
    engine: "Most of what is failing is our test harness, not your app. That one is on us.",
    balanced:
        "No single cause dominates. The environment, the test data and the test plans are each costing about the same.",
    none: undefined,
};

export function suiteHealthDriverNote(driver: SuiteHealthDriver): string | undefined {
    return DRIVER_NOTES[driver];
}

/**
 * The tooltip's paragraph.
 *
 * `calibrating` has two readings and only one is true at a time: a suite that has run is converging, and a suite
 * that has never run has not started converging. Its stored `body` describes the first in the present tense
 * ("now needs real pull requests to learn which ones matter"), so a brand-new application was being told about
 * a process that had not begun. Keyed off `hasEverRun`, which is what `suiteHealthFooter` below already does.
 */
export function suiteHealthBody(health: SuiteHealth): string {
    if (!health.hasEverRun) return NEVER_RUN_BODY;
    return SUITE_HEALTH_PRESENTATION[health.level].body;
}

/** The tooltip's footer: one concrete number from this app, never a generic promise where a fact will do. */
export function suiteHealthFooter(health: SuiteHealth): string {
    const { evidence, staleIssues, trust, level } = health;

    if (!health.hasEverRun) return WAITING_FOR_FIRST_PULL_REQUEST;

    if (staleIssues > 0 && (level === "degraded" || level === "at_risk")) {
        return staleIssues === 1
            ? "1 failure is waiting on a decision"
            : `${staleIssues} failures are waiting on a decision`;
    }

    if (level === "calibrating") return "Most suites reach Steady in ~2 weeks";

    if (level === "steady" && evidence.selfHeals > 0) {
        return `Self-healed ${evidence.selfHeals} tests in the last ${evidence.runs} runs`;
    }

    return `${Math.round(trust)}% of the last ${evidence.runs} runs reached a verdict`;
}

/**
 * The meter's stat line: `21 runs · 3 PRs · 2 heals`. Kept terse rather than spelling out "self-heals" because the
 * sidebar is under 200px wide and the longer word clips.
 */
export function suiteHealthStats(health: SuiteHealth): string {
    const { runs, pullRequests, selfHeals } = health.evidence;
    return `${runs} runs · ${pullRequests} PRs · ${selfHeals} heals`;
}
