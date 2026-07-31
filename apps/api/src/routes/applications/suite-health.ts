import {
    DEFAULT_SUITE_HEALTH_LEVEL,
    type SuiteHealth,
    type SuiteHealthBreakdown,
    type SuiteHealthDriver,
    type SuiteHealthGate,
    type SuiteHealthLevel,
    suiteHealthLevelAtRank,
    suiteHealthRank,
} from "@autonoma/types";

/** How many analysis runs the score is computed over, and how far back it will reach to find them. */
export const SUITE_HEALTH_WINDOW_RUNS = 20;
export const SUITE_HEALTH_WINDOW_DAYS = 30;

/** An open issue this old on a live branch is what "failures left unresolved for days" means. */
export const SUITE_HEALTH_STALE_ISSUE_DAYS = 7;

// A healed test already lands in the trust numerator as `passed`, so the bonus scores the loop's SUCCESS RATE
// rather than its volume - paying per heal would count the same event twice and would reward a suite for needing
// a lot of repair. The minimum stops one lucky heal out of one attempt reading as a perfect rate.
const SELF_HEAL_MIN_ATTEMPTS = 5;
const SELF_HEAL_MAX_BONUS = 8;

const TRIAGE_BONUS = 5;
const TRIAGE_SUSTAINED_BONUS = 10;
const TRIAGE_SUSTAINED_MIN_RESOLVED = 3;

// A run that dies produces no findings at all, so it is invisible to the trust rate. Without this term an app
// whose analysis fails outright looks identical to one where it always completes.
const PIPELINE_FAILURE_MAX_PENALTY = 15;

const STALE_ISSUE_PENALTY = 5;
const STALE_ISSUE_MAX_PENALTY = 20;

/** Score bands, highest first. Anything below the last entry is `degraded`. */
const SCORE_BANDS: ReadonlyArray<{ min: number; level: SuiteHealthLevel }> = [
    { min: 85, level: "proven" },
    { min: 65, level: "steady" },
    { min: 35, level: "calibrating" },
    { min: 15, level: "at_risk" },
];

// Evidence gates. A suite may not climb past CALIBRATING on a handful of lucky runs, and - just as important -
// may not fall below it on a handful of unlucky ones.
const STEADY_MIN_RUNS = 8;
const STEADY_MIN_PULL_REQUESTS = 3;
const STEADY_MIN_AGE_DAYS = 7;
const PROVEN_MIN_RUNS = 20;
const PROVEN_MIN_PULL_REQUESTS = 8;
const PROVEN_MIN_AGE_DAYS = 30;
const AT_RISK_MIN_RUNS = 5;
const DEGRADED_MIN_RUNS = 12;

// Silence alone is not a failure; silence with unresolved failures is. Past the grace period a suite with open
// issues sheds a level, then another for every decay period after that.
const INACTIVITY_GRACE_DAYS = 21;
const INACTIVITY_DECAY_DAYS = 14;

/** Share of the losses a single cause must own before the tooltip names it instead of saying "balanced". */
const DRIVER_DOMINANCE_SHARE = 0.4;

export interface SuiteHealthInput {
    breakdown: SuiteHealthBreakdown;
    runs: number;
    pullRequests: number;
    /** Re-planned, re-run tests that then passed. */
    selfHeals: number;
    /** Re-planned, re-run tests, whatever the outcome. */
    selfHealAttempts: number;
    ageDays: number;
    daysSinceLastRun: number;
    /**
     * Analysis runs that died in the window. The caller must already have excluded supersessions: in production
     * 252 of 254 `failed` jobs are "Superseded by a newer analysis request", which is a run being replaced by a
     * newer push, not a failure - counting those turns this into a penalty for shipping often.
     */
    failedJobs: number;
    totalJobs: number;
    staleIssues: number;
    /** Issues that went open -> resolved inside the window. */
    resolvedIssues: number;
    hasEverRun: boolean;
}

/**
 * Scores a test suite's trustworthiness on the five-step ladder.
 *
 * The base is the **trust rate**: of the tests the agent investigated, how many produced a verdict you can act on
 * (`passed` or `client_bug`). A confirmed bug RAISES health - a suite that finds a real bug is doing its job. What
 * lowers it is a run that reaches no verdict at all, because the environment was down, the data was mis-seeded,
 * our harness crashed, or the test itself was wrong about the app.
 *
 * Bounded modifiers then adjust it, and the evidence gates clamp the resulting band so a new suite can neither
 * climb nor fall without having earned it.
 */
export function computeSuiteHealth(input: SuiteHealthInput): SuiteHealth {
    const evidence = {
        runs: input.runs,
        pullRequests: input.pullRequests,
        selfHeals: input.selfHeals,
        selfHealAttempts: input.selfHealAttempts,
        findings: countFindings(input.breakdown),
        ageDays: input.ageDays,
        daysSinceLastRun: input.daysSinceLastRun,
    };

    // Nothing has been investigated yet: every app starts at CALIBRATING, not at zero and not at green.
    if (!input.hasEverRun || evidence.findings === 0) {
        return {
            level: DEFAULT_SUITE_HEALTH_LEVEL,
            rank: suiteHealthRank(DEFAULT_SUITE_HEALTH_LEVEL),
            score: 0,
            trust: 0,
            evidence,
            breakdown: input.breakdown,
            driver: "none",
            staleIssues: input.staleIssues,
            hasEverRun: input.hasEverRun,
        };
    }

    const trust = (100 * (input.breakdown.passed + input.breakdown.clientBug)) / evidence.findings;
    const score = clamp(trust + totalModifier(input), 0, 100);

    const band = bandFor(score);
    const { cap, gate } = evidenceCap(input);
    const floor = evidenceFloor(input.runs);

    const gated = clampLevel(band, floor, cap);
    const level = applyInactivityDecay(gated, input);
    const isHeldBackByGate = suiteHealthRank(cap) < suiteHealthRank(band);

    return {
        level,
        rank: suiteHealthRank(level),
        score: round(score),
        trust: round(trust),
        evidence,
        breakdown: input.breakdown,
        driver: dominantDriver(input.breakdown),
        staleIssues: input.staleIssues,
        gatedBy: isHeldBackByGate ? gate : undefined,
        hasEverRun: true,
    };
}

function countFindings(breakdown: SuiteHealthBreakdown): number {
    return (
        breakdown.passed +
        breakdown.clientBug +
        breakdown.environmentFailure +
        breakdown.scenarioIssue +
        breakdown.planMismatch +
        breakdown.engineArtifact +
        breakdown.invalidTest
    );
}

function totalModifier(input: SuiteHealthInput): number {
    return selfHealBonus(input) + triageBonus(input.resolvedIssues) - pipelinePenalty(input) - stalenessPenalty(input);
}

function selfHealBonus({ selfHeals, selfHealAttempts }: SuiteHealthInput): number {
    if (selfHealAttempts < SELF_HEAL_MIN_ATTEMPTS) return 0;
    return SELF_HEAL_MAX_BONUS * (selfHeals / selfHealAttempts);
}

function triageBonus(resolvedIssues: number): number {
    if (resolvedIssues >= TRIAGE_SUSTAINED_MIN_RESOLVED) return TRIAGE_SUSTAINED_BONUS;
    if (resolvedIssues >= 1) return TRIAGE_BONUS;
    return 0;
}

function pipelinePenalty({ failedJobs, totalJobs }: SuiteHealthInput): number {
    if (totalJobs === 0) return 0;
    return PIPELINE_FAILURE_MAX_PENALTY * (failedJobs / totalJobs);
}

function stalenessPenalty({ staleIssues }: SuiteHealthInput): number {
    return Math.min(STALE_ISSUE_MAX_PENALTY, STALE_ISSUE_PENALTY * staleIssues);
}

function bandFor(score: number): SuiteHealthLevel {
    const band = SCORE_BANDS.find((candidate) => score >= candidate.min);
    return band?.level ?? "degraded";
}

/** The highest level the evidence supports, and the first unmet requirement holding it there. */
function evidenceCap(input: SuiteHealthInput): { cap: SuiteHealthLevel; gate?: SuiteHealthGate } {
    const steadyGate = firstUnmetGate([
        { met: input.runs >= STEADY_MIN_RUNS, gate: "runs" },
        { met: input.pullRequests >= STEADY_MIN_PULL_REQUESTS, gate: "pull_requests" },
        { met: input.ageDays >= STEADY_MIN_AGE_DAYS, gate: "age" },
    ]);
    if (steadyGate != null) return { cap: "calibrating", gate: steadyGate };

    const provenGate = firstUnmetGate([
        { met: input.runs >= PROVEN_MIN_RUNS, gate: "runs" },
        { met: input.pullRequests >= PROVEN_MIN_PULL_REQUESTS, gate: "pull_requests" },
        { met: input.ageDays >= PROVEN_MIN_AGE_DAYS, gate: "age" },
        { met: input.staleIssues === 0, gate: "stale_issues" },
        { met: input.resolvedIssues >= 1, gate: "no_triage" },
    ]);
    if (provenGate != null) return { cap: "steady", gate: provenGate };

    return { cap: "proven" };
}

function firstUnmetGate(
    requirements: ReadonlyArray<{ met: boolean; gate: SuiteHealthGate }>,
): SuiteHealthGate | undefined {
    return requirements.find((requirement) => !requirement.met)?.gate;
}

/** The lowest level the evidence supports. Too few runs to condemn a suite is too few runs, full stop. */
function evidenceFloor(runs: number): SuiteHealthLevel {
    if (runs < AT_RISK_MIN_RUNS) return "calibrating";
    if (runs < DEGRADED_MIN_RUNS) return "at_risk";
    return "degraded";
}

function clampLevel(level: SuiteHealthLevel, floor: SuiteHealthLevel, cap: SuiteHealthLevel): SuiteHealthLevel {
    const rank = Math.min(suiteHealthRank(cap), Math.max(suiteHealthRank(floor), suiteHealthRank(level)));
    return suiteHealthLevelAtRank(rank);
}

/**
 * Applied AFTER the evidence floor, and deliberately not re-clamped to it: abandonment can take a suite below the
 * level its run count alone would allow.
 *
 * That looks like it contradicts the floor, but the two measure different things. The floor exists because a
 * handful of unlucky runs is not enough to condemn a suite. Decay does not fire on unlucky runs - it needs open
 * issues that have sat unresolved past the stale threshold AND no run at all for three weeks. A suite with three
 * runs, week-old untriaged failures and nobody looking at it for a quarter is genuinely degraded, and the run
 * count says nothing about that.
 */
function applyInactivityDecay(level: SuiteHealthLevel, input: SuiteHealthInput): SuiteHealthLevel {
    const isAbandoned = input.daysSinceLastRun > INACTIVITY_GRACE_DAYS && input.staleIssues > 0;
    if (!isAbandoned) return level;

    const overdueDays = input.daysSinceLastRun - INACTIVITY_GRACE_DAYS;
    const drops = 1 + Math.floor(overdueDays / INACTIVITY_DECAY_DAYS);
    return suiteHealthLevelAtRank(suiteHealthRank(level) - drops);
}

function dominantDriver(breakdown: SuiteHealthBreakdown): SuiteHealthDriver {
    const causes: ReadonlyArray<{ driver: SuiteHealthDriver; count: number }> = [
        { driver: "environment", count: breakdown.environmentFailure },
        { driver: "scenario", count: breakdown.scenarioIssue },
        // A test the agent could not stabilise and one it proved impossible are the same story to the reader:
        // the tests do not match the app yet.
        { driver: "plan", count: breakdown.planMismatch + breakdown.invalidTest },
        { driver: "engine", count: breakdown.engineArtifact },
    ];

    const losses = causes.reduce((total, cause) => total + cause.count, 0);
    if (losses === 0) return "none";

    const leader = causes.reduce((best, cause) => (cause.count > best.count ? cause : best));
    return leader.count / losses >= DRIVER_DOMINANCE_SHARE ? leader.driver : "balanced";
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
    return Math.round(value * 10) / 10;
}
