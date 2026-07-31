import type { SuiteHealthBreakdown, SuiteHealthLevel } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { type SuiteHealthInput, computeSuiteHealth } from "../../src/routes/applications/suite-health";

const NOTHING: SuiteHealthBreakdown = {
    passed: 0,
    clientBug: 0,
    environmentFailure: 0,
    scenarioIssue: 0,
    planMismatch: 0,
    engineArtifact: 0,
    invalidTest: 0,
};

/** A suite with plenty of evidence and no modifiers firing, so a test can move one variable at a time. */
function input(overrides: Partial<SuiteHealthInput> = {}): SuiteHealthInput {
    return {
        breakdown: NOTHING,
        runs: 20,
        pullRequests: 12,
        selfHeals: 0,
        selfHealAttempts: 0,
        ageDays: 60,
        daysSinceLastRun: 0,
        failedJobs: 0,
        totalJobs: 20,
        staleIssues: 0,
        resolvedIssues: 0,
        hasEverRun: true,
        ...overrides,
    };
}

function breakdown(overrides: Partial<SuiteHealthBreakdown>): SuiteHealthBreakdown {
    return { ...NOTHING, ...overrides };
}

describe("computeSuiteHealth", () => {
    it("starts a brand-new app at calibrating rather than at zero or at green", () => {
        const health = computeSuiteHealth(input({ runs: 0, pullRequests: 0, totalJobs: 0, hasEverRun: false }));

        expect(health.level).toBe("calibrating");
        expect(health.rank).toBe(3);
        expect(health.hasEverRun).toBe(false);
    });

    it("counts a confirmed bug as a trustworthy verdict, not as damage", () => {
        const allBugs = computeSuiteHealth(input({ breakdown: breakdown({ clientBug: 20 }) }));
        const allPasses = computeSuiteHealth(input({ breakdown: breakdown({ passed: 20 }) }));

        expect(allBugs.trust).toBe(100);
        expect(allBugs.score).toBe(allPasses.score);
    });

    it("treats a blocked run as worthless rather than as a failure of the app", () => {
        const health = computeSuiteHealth(
            input({ breakdown: breakdown({ passed: 5, environmentFailure: 10, scenarioIssue: 5 }) }),
        );

        expect(health.trust).toBe(25);
        expect(health.driver).toBe("environment");
    });

    it("will not promote past calibrating without enough runs, PRs and history", () => {
        const perfect = breakdown({ passed: 40 });

        expect(computeSuiteHealth(input({ breakdown: perfect, runs: 4 })).level).toBe("calibrating");
        expect(computeSuiteHealth(input({ breakdown: perfect, pullRequests: 2 })).level).toBe("calibrating");
        expect(computeSuiteHealth(input({ breakdown: perfect, ageDays: 3 })).level).toBe("calibrating");
    });

    it("reports which gate is holding a suite below the level its score earned", () => {
        const health = computeSuiteHealth(input({ breakdown: breakdown({ passed: 40 }), ageDays: 10 }));

        expect(health.score).toBe(100);
        expect(health.level).toBe("steady");
        expect(health.gatedBy).toBe("age");
    });

    it("requires triage and a clean backlog before a suite can be called proven", () => {
        const perfect = breakdown({ passed: 40 });

        expect(computeSuiteHealth(input({ breakdown: perfect, resolvedIssues: 0 })).level).toBe("steady");
        expect(computeSuiteHealth(input({ breakdown: perfect, resolvedIssues: 2, staleIssues: 1 })).level).toBe(
            "steady",
        );
        expect(computeSuiteHealth(input({ breakdown: perfect, resolvedIssues: 2 })).level).toBe("proven");
    });

    it("will not condemn a suite on a handful of unlucky runs", () => {
        const disaster = breakdown({ environmentFailure: 30 });

        expect(computeSuiteHealth(input({ breakdown: disaster, runs: 3 })).level).toBe("calibrating");
        expect(computeSuiteHealth(input({ breakdown: disaster, runs: 8 })).level).toBe("at_risk");
        expect(computeSuiteHealth(input({ breakdown: disaster, runs: 20 })).level).toBe("degraded");
    });

    it("scores the self-heal loop by success rate, so a healed test is not counted twice", () => {
        const base = breakdown({ passed: 10, planMismatch: 10 });

        const effective = computeSuiteHealth(input({ breakdown: base, selfHealAttempts: 10, selfHeals: 10 }));
        const futile = computeSuiteHealth(input({ breakdown: base, selfHealAttempts: 10, selfHeals: 0 }));
        // Volume alone earns nothing: a loop that runs twice as often but saves the same share scores the same.
        const busier = computeSuiteHealth(input({ breakdown: base, selfHealAttempts: 20, selfHeals: 20 }));

        expect(effective.score).toBeGreaterThan(futile.score);
        expect(busier.score).toBe(effective.score);
    });

    it("ignores a self-heal rate drawn from too few attempts", () => {
        const base = breakdown({ passed: 10, planMismatch: 10 });

        const lucky = computeSuiteHealth(input({ breakdown: base, selfHealAttempts: 1, selfHeals: 1 }));
        const none = computeSuiteHealth(input({ breakdown: base }));

        expect(lucky.score).toBe(none.score);
    });

    it("docks a suite for failures left open for a week on a live branch", () => {
        const base = breakdown({ passed: 12, planMismatch: 8 });

        const clean = computeSuiteHealth(input({ breakdown: base }));
        const neglected = computeSuiteHealth(input({ breakdown: base, staleIssues: 3 }));

        expect(clean.score - neglected.score).toBe(15);
    });

    it("decays an abandoned suite that still has open failures, but not a quiet clean one", () => {
        const base = breakdown({ passed: 30, planMismatch: 10 });

        const quiet = computeSuiteHealth(input({ breakdown: base, daysSinceLastRun: 90 }));
        const abandoned = computeSuiteHealth(input({ breakdown: base, daysSinceLastRun: 90, staleIssues: 2 }));

        expect(quiet.level).toBe("steady");
        expect(abandoned.level).toBe("degraded");
    });

    it("names the dominant cause, and says balanced when nothing dominates", () => {
        expect(computeSuiteHealth(input({ breakdown: breakdown({ scenarioIssue: 20 }) })).driver).toBe("scenario");
        expect(computeSuiteHealth(input({ breakdown: breakdown({ engineArtifact: 20 }) })).driver).toBe("engine");
        expect(computeSuiteHealth(input({ breakdown: breakdown({ planMismatch: 20 }) })).driver).toBe("plan");
        expect(computeSuiteHealth(input({ breakdown: breakdown({ passed: 20 }) })).driver).toBe("none");
        expect(
            computeSuiteHealth(
                input({
                    breakdown: breakdown({
                        environmentFailure: 5,
                        scenarioIssue: 5,
                        planMismatch: 5,
                        engineArtifact: 5,
                    }),
                }),
            ).driver,
        ).toBe("balanced");
    });

    it("does not penalise a suite for a superseded run the caller already filtered out", () => {
        const base = breakdown({ passed: 20 });

        const withFailures = computeSuiteHealth(input({ breakdown: base, failedJobs: 10, totalJobs: 20 }));
        const withoutFailures = computeSuiteHealth(input({ breakdown: base, failedJobs: 0, totalJobs: 20 }));

        expect(withoutFailures.score - withFailures.score).toBe(7.5);
    });
});

/**
 * Every application in production with analysis data on 2026-07-31, over the real last-20-run window. This is the
 * regression guard on the thresholds themselves: tuning any constant should show, right here, exactly which
 * customers change level - so the tuning is a deliberate call rather than a surprise.
 */
interface ProductionCase {
    app: string;
    input: SuiteHealthInput;
    level: SuiteHealthLevel;
}

function productionCase(
    app: string,
    counts: {
        runs: number;
        prs: number;
        passed: number;
        bug?: number;
        env?: number;
        scenario?: number;
        mismatch?: number;
        engine?: number;
        heals?: number;
        healAttempts?: number;
        jobs: number;
        failedJobs?: number;
        resolved?: number;
        ageDays: number;
    },
    level: SuiteHealthLevel,
): ProductionCase {
    return {
        app,
        level,
        input: {
            breakdown: breakdown({
                passed: counts.passed,
                clientBug: counts.bug ?? 0,
                environmentFailure: counts.env ?? 0,
                scenarioIssue: counts.scenario ?? 0,
                planMismatch: counts.mismatch ?? 0,
                engineArtifact: counts.engine ?? 0,
            }),
            runs: counts.runs,
            pullRequests: counts.prs,
            selfHeals: counts.heals ?? 0,
            selfHealAttempts: counts.healAttempts ?? 0,
            ageDays: counts.ageDays,
            daysSinceLastRun: 0,
            failedJobs: counts.failedJobs ?? 0,
            totalJobs: counts.jobs,
            staleIssues: 0,
            resolvedIssues: counts.resolved ?? 0,
            hasEverRun: true,
        },
    };
}

const PRODUCTION_CASES: ProductionCase[] = [
    // Cleanest suite we have. Its score earns PROVEN; only its age holds it at STEADY.
    productionCase(
        "autonoma/online-bank",
        { runs: 20, prs: 12, passed: 67, bug: 4, env: 2, engine: 4, heals: 3, healAttempts: 13, jobs: 22, ageDays: 15 },
        "steady",
    ),
    productionCase(
        "onecrew/one-crew",
        {
            runs: 20,
            prs: 12,
            passed: 42,
            env: 10,
            scenario: 8,
            mismatch: 15,
            engine: 1,
            heals: 3,
            healAttempts: 15,
            jobs: 31,
            ageDays: 44,
        },
        "calibrating",
    ),
    productionCase(
        "usehorizon-ai/horizon",
        {
            runs: 8,
            prs: 5,
            passed: 22,
            env: 3,
            scenario: 2,
            mismatch: 12,
            engine: 2,
            heals: 4,
            healAttempts: 15,
            jobs: 9,
            failedJobs: 1,
            ageDays: 78,
        },
        "calibrating",
    ),
    productionCase(
        "agree-com/agree-web",
        {
            runs: 20,
            prs: 12,
            passed: 53,
            env: 22,
            scenario: 9,
            mismatch: 17,
            engine: 9,
            heals: 14,
            healAttempts: 26,
            jobs: 24,
            resolved: 1,
            ageDays: 70,
        },
        "calibrating",
    ),
    productionCase(
        "eddi/eddi-monorepo",
        {
            runs: 14,
            prs: 10,
            passed: 30,
            env: 6,
            scenario: 8,
            mismatch: 11,
            engine: 9,
            heals: 10,
            healAttempts: 18,
            jobs: 19,
            ageDays: 65,
        },
        "calibrating",
    ),
    productionCase(
        "centinel-finance/centinel-app",
        {
            runs: 20,
            prs: 13,
            passed: 21,
            env: 32,
            scenario: 19,
            mismatch: 4,
            engine: 3,
            heals: 3,
            healAttempts: 6,
            jobs: 31,
            ageDays: 56,
        },
        "at_risk",
    ),
    // Only four runs: too little evidence to call it AT RISK, however bad those four look.
    productionCase(
        "autonoma-ai/agent",
        {
            runs: 4,
            prs: 4,
            passed: 4,
            bug: 2,
            env: 10,
            scenario: 14,
            mismatch: 7,
            engine: 1,
            heals: 3,
            healAttempts: 9,
            jobs: 4,
            ageDays: 7,
        },
        "calibrating",
    ),
    // 87% engine_artifact: our harness crashing, not their app - but the suite still cannot be trusted.
    productionCase(
        "sandstone/sandstone",
        {
            runs: 20,
            prs: 16,
            passed: 12,
            env: 4,
            scenario: 1,
            mismatch: 1,
            engine: 125,
            healAttempts: 1,
            jobs: 31,
            ageDays: 48,
        },
        "degraded",
    ),
    productionCase(
        "vercel/devansh-portfolio",
        { runs: 2, prs: 1, passed: 1, env: 11, jobs: 2, ageDays: 0 },
        "calibrating",
    ),
    productionCase(
        "britishfooddepot-com/bigcommerce-sync",
        {
            runs: 20,
            prs: 14,
            passed: 7,
            bug: 1,
            env: 44,
            scenario: 95,
            mismatch: 14,
            engine: 6,
            heals: 1,
            healAttempts: 12,
            jobs: 29,
            ageDays: 6,
        },
        "degraded",
    ),
    productionCase(
        "eon/eon-app",
        { runs: 8, prs: 3, passed: 1, scenario: 35, engine: 2, jobs: 24, failedJobs: 1, ageDays: 55 },
        "at_risk",
    ),
    productionCase(
        "mackenzie-nolan/prs-walmart-prime",
        { runs: 4, prs: 2, passed: 0, env: 7, scenario: 3, jobs: 4, ageDays: 7 },
        "calibrating",
    ),
    productionCase(
        "abass/bow-and-beautiful-salon-admin",
        { runs: 3, prs: 3, passed: 0, env: 7, engine: 2, jobs: 3, ageDays: 8 },
        "calibrating",
    ),
    productionCase("project/opticore", { runs: 6, prs: 1, passed: 0, scenario: 37, jobs: 6, ageDays: 6 }, "at_risk"),
    productionCase(
        "autonoma/cal",
        { runs: 4, prs: 4, passed: 0, env: 2, scenario: 13, mismatch: 4, healAttempts: 4, jobs: 4, ageDays: 1 },
        "calibrating",
    ),
    // Its scenario recipe has never worked: not one run in twenty reached a verdict.
    productionCase(
        "homa/homa-next",
        { runs: 20, prs: 9, passed: 0, env: 23, scenario: 144, jobs: 20, ageDays: 48 },
        "degraded",
    ),
];

describe("computeSuiteHealth against production", () => {
    it.each(PRODUCTION_CASES)("puts $app at $level", ({ input: fixture, level }) => {
        expect(computeSuiteHealth(fixture).level).toBe(level);
    });

    it("centres the fleet on calibrating", () => {
        const levels = PRODUCTION_CASES.map((testCase) => computeSuiteHealth(testCase.input).level);
        const count = (level: SuiteHealthLevel) => levels.filter((candidate) => candidate === level).length;

        expect(count("calibrating")).toBeGreaterThan(count("steady") + count("proven"));
        expect(count("calibrating")).toBeGreaterThan(count("at_risk") + count("degraded"));
    });
});
