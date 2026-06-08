import type { PrismaClient } from "@autonoma/db";
import {
    type PlanRevision,
    type PriorVerdict,
    type ReplayChangeContext,
    type ReviewLineage,
    type RunContext,
    type RunStepData,
    resolveScenarioDataForRun,
} from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

/**
 * One refinement-iteration analysis-scope row for the subject test, carrying the
 * plan it scoped and the iteration that scoped it. The shared shape both the
 * plan-history and prior-verdict walks read from.
 */
interface IterationPlanInput {
    plan: { id: string; prompt: string };
    iteration: { number: number };
}

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
                // The plan this run actually executed (captured at run creation). It
                // also anchors the lineage walk: this plan id locates the run's
                // refinement iteration, which bounds the point-in-time history.
                planId: true,
                // `run.plan` is the snapshot of the plan this run actually executed,
                // captured at run creation time. Reading it from `assignment.plan`
                // instead would be wrong after any `updatePlan` call (e.g. healing),
                // which re-points `assignment.planId` to a *new* TestPlan row -
                // so the reviewer would otherwise grade the run against a prompt
                // it never saw.
                plan: { select: { prompt: true } },
                assignment: {
                    select: {
                        testCase: { select: { id: true, name: true } },
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
        const lineage = await this.buildLineage(runId, run.planId, run.assignment.testCase.id);

        // Resolved + materialized via the shared, agent-agnostic helper so the
        // loader stays DB-only and resolution/healing reuse the same path.
        // Returns undefined (and we omit it) when the run has no scenario, UP
        // never succeeded, or the graph is empty.
        const scenario = await resolveScenarioDataForRun(this.db, runId);

        this.logger.info("Replay review context loaded", {
            runId,
            stepCount: steps.length,
            hasChange: change != null,
            hasLineage: lineage != null,
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
        if (lineage != null) context.lineage = lineage;
        if (scenario != null) context.scenario = scenario;
        return context;
    }

    /**
     * Gather the subject test's point-in-time refinement-loop lineage: the plan
     * rewrite history (oldest first, up to and including the plan this run
     * executed) and earlier iterations' verdicts on this same test.
     *
     * "Point-in-time" is enforced two ways: the history is capped at the subject
     * run's own iteration number (later iterations may already exist in the DB by
     * the time a re-review runs, but they did not exist when this run executed),
     * and only `completed` reviews from *earlier* iterations contribute verdicts.
     *
     * Returns `undefined` when there is nothing to show: the run isn't part of a
     * refinement loop, or it's a first-iteration run (no earlier iterations, so no
     * rewrite and no prior verdict). First-iteration reviews therefore carry no
     * lineage at all - exactly the case this fix leaves alone.
     */
    private async buildLineage(
        runId: string,
        planId: string | null,
        testCaseId: string,
    ): Promise<ReviewLineage | undefined> {
        if (planId == null) return undefined;

        // The run's executed plan is the analysis-scope input to exactly one
        // refinement iteration; that iteration's number and loop bound the walk.
        const subjectInput = await this.db.refinementIterationInput.findFirst({
            where: { planId },
            select: { iteration: { select: { number: true, loopId: true } } },
        });
        if (subjectInput == null) {
            this.logger.info("Run is not part of a refinement loop - no lineage", { runId });
            return undefined;
        }

        const { number: subjectNumber, loopId } = subjectInput.iteration;
        if (subjectNumber <= 1) {
            this.logger.info("First-iteration run - no lineage", { runId, iteration: subjectNumber });
            return undefined;
        }

        // Single source of truth for both the history and the verdicts: every plan
        // this test was scoped to from the seed iteration through the subject's own
        // iteration. Capping at `subjectNumber` keeps the view point-in-time even if
        // later iterations already exist in the DB by the time this review runs.
        const inputs = await this.db.refinementIterationInput.findMany({
            where: {
                plan: { testCaseId },
                iteration: { loopId, number: { lte: subjectNumber } },
            },
            select: {
                plan: { select: { id: true, prompt: true } },
                iteration: { select: { number: true } },
            },
            orderBy: { iteration: { number: "asc" } },
        });

        const planHistory = await this.buildPlanHistory(loopId, inputs);
        const priorVerdicts = await this.buildPriorVerdicts(inputs, subjectNumber);

        this.logger.info("Gathered review lineage", {
            runId,
            iteration: subjectNumber,
            planRevisions: planHistory.length,
            priorVerdicts: priorVerdicts.length,
        });

        return { priorVerdicts, planHistory };
    }

    /**
     * The chronological plan rewrite history for this test inside the loop, from
     * the seed plan (iteration 1) through the plan the subject run executed. Each
     * rewrite's `healingReasoning` comes from the `update_plan` action that created
     * the plan; the seed plan has none.
     */
    private async buildPlanHistory(loopId: string, inputs: IterationPlanInput[]): Promise<PlanRevision[]> {
        const planIds = inputs.map((input) => input.plan.id);
        const actions = await this.db.refinementAction.findMany({
            where: { kind: "update_plan", planId: { in: planIds }, iteration: { loopId } },
            select: { planId: true, reasoning: true },
        });
        const reasoningByPlanId = new Map(actions.map((action) => [action.planId, action.reasoning]));

        return inputs.map((input) => {
            const revision: PlanRevision = {
                iterationNumber: input.iteration.number,
                prompt: input.plan.prompt,
            };
            const healingReasoning = reasoningByPlanId.get(input.plan.id);
            if (healingReasoning != null) revision.healingReasoning = healingReasoning;
            return revision;
        });
    }

    /**
     * The verdicts earlier iterations reached on this test, oldest first. Sourced
     * from `completed` `RunReview`s of the runs that executed the *earlier* plans
     * (the subject iteration's own runs are excluded - that's the review in
     * progress). Each prior run maps back to its iteration number via its plan.
     */
    private async buildPriorVerdicts(inputs: IterationPlanInput[], subjectNumber: number): Promise<PriorVerdict[]> {
        const earlierInputs = inputs.filter((input) => input.iteration.number < subjectNumber);
        if (earlierInputs.length === 0) return [];

        const iterationByPlanId = new Map(earlierInputs.map((input) => [input.plan.id, input.iteration.number]));
        const earlierPlanIds = earlierInputs.map((input) => input.plan.id);

        const priorRuns = await this.db.run.findMany({
            where: {
                planId: { in: earlierPlanIds },
                runReview: { status: "completed", verdict: { not: null } },
            },
            select: {
                planId: true,
                runReview: { select: { verdict: true, reasoning: true } },
            },
            orderBy: { createdAt: "asc" },
        });

        const verdicts: PriorVerdict[] = [];
        for (const run of priorRuns) {
            const verdict = run.runReview?.verdict;
            if (run.planId == null || verdict == null) continue;
            const iterationNumber = iterationByPlanId.get(run.planId);
            if (iterationNumber == null) continue;
            verdicts.push({
                iterationNumber,
                verdict,
                reasoning: run.runReview?.reasoning ?? "",
            });
        }

        verdicts.sort((a, b) => a.iterationNumber - b.iterationNumber);
        return verdicts;
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
