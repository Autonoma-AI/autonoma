import { AnalysisStore } from "@autonoma/analysis";
import { type PrismaClient, TriggerSource } from "@autonoma/db";
import { ANALYSIS_VERDICT, type SuiteHealth, type SuiteHealthBreakdown } from "@autonoma/types";
import { Service } from "../service";
import {
    SUITE_HEALTH_STALE_ISSUE_DAYS,
    SUITE_HEALTH_WINDOW_DAYS,
    SUITE_HEALTH_WINDOW_RUNS,
    computeSuiteHealth,
} from "./suite-health";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** PR states whose branch is finished, so an issue left open on it is not a live, untriaged failure. */
const CLOSED_PR_STATES = ["merged", "closed"] as const;

/** An empty tally, so a verdict with no findings still reports a zero rather than an absent key. */
function emptyBreakdown(): SuiteHealthBreakdown {
    return {
        passed: 0,
        clientBug: 0,
        environmentFailure: 0,
        scenarioIssue: 0,
        planMismatch: 0,
        engineArtifact: 0,
        invalidTest: 0,
    };
}

/**
 * Computes an application's {@link SuiteHealth} - the five-state trust signal in the app sidebar.
 *
 * The window is the last {@link SUITE_HEALTH_WINDOW_RUNS} analysis runs that produced at least one finding, no
 * older than {@link SUITE_HEALTH_WINDOW_DAYS}. A run counts once no matter how many tests it investigated, so one
 * large pull request cannot swing the number on its own; a completed run that selected no tests is excluded
 * entirely, because it is neither good nor bad.
 */
export class SuiteHealthService extends Service {
    private readonly analysisStore: AnalysisStore;

    constructor(private readonly db: PrismaClient) {
        super();
        this.analysisStore = new AnalysisStore(db);
    }

    async getForApplication(applicationId: string, organizationId: string): Promise<SuiteHealth> {
        this.logger.info("Computing suite health", {
            application: { applicationId },
            organization: { organizationId },
        });

        const facts = this.analysisStore.forApplication(applicationId, organizationId);
        const [runs, firstRunAt] = await Promise.all([
            facts.recentRuns({
                since: new Date(Date.now() - SUITE_HEALTH_WINDOW_DAYS * MS_PER_DAY),
                limit: SUITE_HEALTH_WINDOW_RUNS,
            }),
            this.firstRunAt(applicationId, organizationId),
        ]);

        const now = new Date();

        if (runs.length === 0 || firstRunAt == null) {
            this.logger.info("Suite health: no analysis runs yet", { application: { applicationId } });
            return computeSuiteHealth({
                breakdown: emptyBreakdown(),
                runs: 0,
                pullRequests: 0,
                selfHeals: 0,
                selfHealAttempts: 0,
                ageDays: 0,
                daysSinceLastRun: 0,
                failedJobs: 0,
                totalJobs: 0,
                staleIssues: 0,
                resolvedIssues: 0,
                hasEverRun: firstRunAt != null,
            });
        }

        // `recentRuns` returns newest first, so the window opens at the oldest run it kept.
        const windowStart = runs[runs.length - 1]?.createdAt ?? now;
        const lastRunAt = runs[0]?.createdAt ?? now;
        const snapshotIds = runs.map((run) => run.snapshotId);

        const [tallies, jobCounts, staleIssues, resolvedIssues] = await Promise.all([
            facts.verdictTallies(snapshotIds),
            facts.jobCounts({ since: windowStart }),
            facts.staleOpenIssueCount({
                olderThan: new Date(now.getTime() - SUITE_HEALTH_STALE_ISSUE_DAYS * MS_PER_DAY),
                closedPrStates: CLOSED_PR_STATES,
            }),
            facts.resolvedIssueCount({ since: windowStart }),
        ]);

        const breakdown = emptyBreakdown();
        let selfHeals = 0;
        let selfHealAttempts = 0;

        for (const verdict of tallies) {
            tally(breakdown, verdict.category);

            if (verdict.selfHealed) {
                selfHealAttempts += 1;
                if (verdict.category === ANALYSIS_VERDICT.passed) selfHeals += 1;
            }
        }

        const health = computeSuiteHealth({
            breakdown,
            runs: runs.length,
            pullRequests: new Set(runs.map((run) => run.branchId)).size,
            selfHeals,
            selfHealAttempts,
            ageDays: wholeDaysBetween(firstRunAt, now),
            daysSinceLastRun: wholeDaysBetween(lastRunAt, now),
            failedJobs: jobCounts.genuineFailures,
            totalJobs: jobCounts.total,
            staleIssues,
            resolvedIssues,
            hasEverRun: true,
        });

        this.logger.info("Computed suite health", {
            application: { applicationId },
            extra: {
                level: health.level,
                score: health.score,
                trust: health.trust,
                driver: health.driver,
                runs: health.evidence.runs,
                gatedBy: health.gatedBy,
            },
        });

        return health;
    }

    /**
     * When the application's first run started, or undefined if it has never run. Two things key off it: the age
     * clock (`ageDays`) and `hasEverRun`, which is what separates "waiting for your first PR" from "calibrating".
     *
     * Keyed to the oldest trigger-created snapshot rather than to a job row, so it spans the diffs -> analysis
     * cutover: keying it to `AnalysisJob` would reset every pre-cutover customer's clock, since only post-cutover
     * runs have one. `MANUAL` is excluded because those snapshots are not runs - one is minted at application setup and
     * one per suite edit in the UI, so including them would start the age clock at signup and make `hasEverRun`
     * true for every application that exists.
     */
    private async firstRunAt(applicationId: string, organizationId: string): Promise<Date | undefined> {
        const oldest = await this.db.branchSnapshot.findFirst({
            where: { branch: { applicationId, organizationId }, source: { not: TriggerSource.MANUAL } },
            select: { createdAt: true },
            orderBy: { createdAt: "asc" },
        });
        return oldest?.createdAt;
    }
}

/** Adds one finding to the tally. An unrecognised verdict is dropped rather than mis-attributed. */
function tally(breakdown: SuiteHealthBreakdown, category: string): void {
    switch (category) {
        case ANALYSIS_VERDICT.passed:
            breakdown.passed += 1;
            return;
        case ANALYSIS_VERDICT.client_bug:
            breakdown.clientBug += 1;
            return;
        case ANALYSIS_VERDICT.environment_failure:
            breakdown.environmentFailure += 1;
            return;
        case ANALYSIS_VERDICT.scenario_issue:
            breakdown.scenarioIssue += 1;
            return;
        case ANALYSIS_VERDICT.plan_mismatch:
            breakdown.planMismatch += 1;
            return;
        case ANALYSIS_VERDICT.engine_artifact:
            breakdown.engineArtifact += 1;
            return;
        case ANALYSIS_VERDICT.invalid_test:
            breakdown.invalidTest += 1;
            return;
        default:
            // Rows predating the merged taxonomy (`outdated_test`, `bad_test`, `delete`) land here. Every one of
            // them means "the test was wrong about the app", which is exactly what plan_mismatch means now -
            // attributing them to the engine instead would blame our harness for the customer's tests.
            breakdown.planMismatch += 1;
    }
}

function wholeDaysBetween(from: Date, to: Date): number {
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}
