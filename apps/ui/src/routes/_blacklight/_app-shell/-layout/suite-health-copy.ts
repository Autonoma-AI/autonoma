import type { SuiteHealth, SuiteHealthDriver, SuiteHealthLevel } from "@autonoma/types";

interface SuiteHealthPresentation {
    label: string;
    /** One line, used in the collapsed meter's tooltip and the first-week banner. */
    short: string;
    /** The tooltip's paragraph. */
    body: string;
    /** Tailwind classes for the lit bars, the pill and the header dot at this level. */
    bar: string;
    pill: string;
    dot: string;
}

export const SUITE_HEALTH_PRESENTATION: Record<SuiteHealthLevel, SuiteHealthPresentation> = {
    degraded: {
        label: "Degraded",
        short: "Failures are piling up unresolved. The agent has stopped trusting its own tests.",
        body: "Runs keep failing and nothing has been triaged, so the agent can no longer tell a real bug from a stale test. Clear the open failures to bring it back.",
        bar: "bg-status-critical",
        pill: "border-status-critical/50 bg-status-critical/10 text-status-critical",
        dot: "bg-status-critical",
    },
    at_risk: {
        label: "At risk",
        short: "More tests are flaking than passing. A few decisions from you will fix this.",
        body: "Several tests fail intermittently. Every failure you clear - in the app, the preview or the test data - teaches the agent what to keep, and a handful usually moves this back up.",
        bar: "bg-status-high",
        pill: "border-status-high/50 bg-status-high/10 text-status-high",
        dot: "bg-status-high",
    },
    calibrating: {
        label: "Calibrating",
        short: "New suite. Written from your app, not yet proven against it. Expect some noise.",
        body: "Your suite is new, so it is not proven yet. Every app starts here: the agent wrote these tests from one pass over your app and now needs real pull requests to learn which ones matter and to self-heal the ones that drift.",
        bar: "bg-status-warn",
        pill: "border-status-warn/50 bg-status-warn/10 text-status-warn",
        dot: "bg-status-warn",
    },
    steady: {
        label: "Steady",
        short: "Tests are holding across PRs and the agent is healing drift on its own.",
        body: "The suite has survived enough merges that the agent self-heals selector drift without asking. Failures you see now are much more likely to be real bugs.",
        bar: "bg-primary-ink",
        pill: "border-primary-ink/50 bg-primary-ink/10 text-primary-ink",
        dot: "bg-primary-ink",
    },
    proven: {
        label: "Proven",
        short: "Every failure here is worth reading. False alarms are rare at this level.",
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

/** The tooltip's footer: one concrete number from this app, never a generic promise where a fact will do. */
export function suiteHealthFooter(health: SuiteHealth): string {
    const { evidence, staleIssues, trust, level } = health;

    if (!health.hasEverRun) return "Waiting for your first pull request";

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
