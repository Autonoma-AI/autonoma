import type { PrismaClient } from "@autonoma/db";
import {
    type ReplayChangeContext,
    type RunContext,
    type RunStepData,
    resolveScenarioDataForRun,
} from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

/**
 * Gathers everything the replay reviewer needs for a single failed run, sourced
 * **entirely from Postgres**: the executed steps + test metadata, the
 * subject-scoped change context (base/head SHAs, the diffs-agent's analysis
 * reasoning, and why this test was flagged), and the materialized scenario data
 * the run executed against.
 *
 * This is the only piece of the replay-review path with DB access. It performs
 * no git or filesystem work - the reviewer derives the changed files and diff
 * hunks itself via `git diff` against the checked-out tree - which keeps the
 * reviewer run DB-free and the loader trivially testable against a real Postgres.
 *
 * Multimedia (step screenshots + video) stays referenced by S3 key only; an
 * `EvidenceLoader` rehydrates the bytes at run time.
 */
export class DiffJobContextLoader {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async load(runId: string): Promise<RunContext> {
        this.logger.info("Loading replay review context", { runId });

        const run = await this.db.run.findUniqueOrThrow({
            where: { id: runId },
            select: {
                id: true,
                organizationId: true,
                // `run.plan` is the snapshot of the plan this run actually executed,
                // captured at run creation time. Reading it from `assignment.plan`
                // instead would be wrong after any `updatePlan` call (e.g. healing),
                // which re-points `assignment.planId` to a *new* TestPlan row -
                // so the reviewer would otherwise grade the run against a prompt
                // it never saw.
                plan: { select: { prompt: true } },
                assignment: {
                    select: {
                        testCase: { select: { name: true } },
                        snapshot: {
                            select: {
                                headSha: true,
                                baseSha: true,
                                diffsJob: { select: { analysisReasoning: true } },
                            },
                        },
                    },
                },
                // The AffectedTest row for this run carries why the diffs-agent
                // flagged this test (its category + free-text reasoning).
                affectedTest: { select: { affectedReason: true, reasoning: true } },
                outputs: {
                    select: {
                        list: {
                            select: {
                                order: true,
                                output: true,
                                screenshotBefore: true,
                                screenshotAfter: true,
                                stepInput: { select: { interaction: true, params: true } },
                            },
                            orderBy: { order: "asc" },
                        },
                    },
                },
            },
        });

        const outputSteps = run.outputs?.list ?? [];

        const steps: RunStepData[] = outputSteps.map((step) => ({
            order: step.order,
            interaction: step.stepInput.interaction,
            params: step.stepInput.params,
            output: step.output,
            screenshotBeforeKey: step.screenshotBefore ?? undefined,
            screenshotAfterKey: step.screenshotAfter ?? undefined,
        }));

        const lastStep = outputSteps[outputSteps.length - 1];
        const finalScreenshotKey = lastStep?.screenshotAfter ?? lastStep?.screenshotBefore ?? undefined;

        const change = this.buildChangeContext(runId, run.assignment.snapshot, run.affectedTest);

        // Resolved + materialized via the shared, agent-agnostic helper so the
        // loader stays DB-only and resolution/healing reuse the same path.
        // Returns undefined (and we omit it) when the run has no scenario, UP
        // never succeeded, or the graph is empty.
        const scenario = await resolveScenarioDataForRun(this.db, runId);

        this.logger.info("Replay review context loaded", {
            runId,
            stepCount: steps.length,
            hasChange: change != null,
            hasScenario: scenario != null,
        });

        const context: RunContext = {
            runId: run.id,
            organizationId: run.organizationId,
            testPlanPrompt: run.plan?.prompt ?? "No test plan prompt available",
            testCaseName: run.assignment.testCase.name,
            steps,
            videoS3Key: `run/${runId}/video.webm`,
            finalScreenshotKey,
        };
        if (change != null) context.change = change;
        if (scenario != null) context.scenario = scenario;
        return context;
    }

    /**
     * Assemble the subject-scoped change facts. Returns `undefined` when the
     * snapshot is missing its SHAs - without them the reviewer has nothing to
     * `git diff` against, so the change section would be useless. Analysis
     * reasoning and the affected-test fields are individually optional: a run
     * may predate analysis or not be a flagged test.
     */
    private buildChangeContext(
        runId: string,
        snapshot: {
            headSha: string | null;
            baseSha: string | null;
            diffsJob: { analysisReasoning: string | null } | null;
        },
        affectedTest: { affectedReason: ReplayChangeContext["affectedReason"]; reasoning: string } | null,
    ): ReplayChangeContext | undefined {
        if (snapshot.baseSha == null || snapshot.headSha == null) {
            this.logger.warn("Snapshot is missing base/head SHA - omitting change context from replay review", {
                runId,
            });
            return undefined;
        }

        const change: ReplayChangeContext = {
            baseSha: snapshot.baseSha,
            headSha: snapshot.headSha,
        };

        const analysisReasoning = snapshot.diffsJob?.analysisReasoning;
        if (analysisReasoning != null) change.analysisReasoning = analysisReasoning;

        if (affectedTest != null) {
            change.affectedReason = affectedTest.affectedReason;
            change.affectedReasoning = affectedTest.reasoning;
        }

        return change;
    }
}
