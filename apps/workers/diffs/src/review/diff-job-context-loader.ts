import type { PrismaClient } from "@autonoma/db";
import {
    type ChangeContext,
    type GenerationContext,
    type GenerationStepData,
    type HealingContext,
    type HealingFailureSubject,
    type HealingSubjectContext,
    type IterationLineage,
    type IterationVerdict,
    type RunContext,
    type RunStepData,
    type ScenarioData,
    type SnapshotChangeContext,
    type SnapshotContext,
    type SnapshotRunContext,
    type SnapshotRunReview,
    resolveScenarioDataForGeneration,
    resolveScenarioDataForRun,
} from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { getStepOverlayPoints } from "@autonoma/types";
import type { ModelMessage } from "ai";

/**
 * One refinement-iteration analysis-scope row for the subject test, carrying the
 * plan it scoped and the iteration that scoped it.
 */
interface IterationPlanInput {
    plan: { id: string; prompt: string };
    iteration: { number: number };
}

/**
 * The DB-sourced snapshot facts the change context is assembled from. Shared by
 * the run and generation subjects - both hang off a `BranchSnapshot`.
 */
interface ChangeSnapshot {
    headSha: string | null;
    baseSha: string | null;
    diffsJob: { analysisReasoning: string | null } | null;
}

/** One `StepAttempt` row, the preferred source for generation steps. */
interface GenerationAttemptRow {
    order: number;
    interaction: string;
    params: unknown;
    status: "success" | "failed";
    output: unknown;
    error: string | null;
    errorName: string | null;
    screenshotBefore: string | null;
    screenshotAfter: string | null;
}

/** One `StepInput` (+ its single `StepOutput`), the legacy fallback source. */
interface GenerationStepInputRow {
    order: number;
    interaction: string;
    params: unknown;
    screenshotBefore: string | null;
    screenshotAfter: string | null;
    outputs: { output: unknown }[];
}

/** One persisted replay `StepOutput` (+ its `StepInput`), the replay step source. */
interface ReplayStepOutputRow {
    order: number;
    output: unknown;
    screenshotBefore: string | null;
    screenshotAfter: string | null;
    stepInput: { interaction: string; params: unknown };
}

/**
 * Gathers everything a diff-job agent needs from the database, at one of two
 * scopes:
 *
 * - **Subject scope** (`load` / `loadGeneration`): everything a reviewer needs
 *   for a single subject - a failed replay run **or** a test generation: the
 *   executed steps + test metadata, the subject-scoped change context (base/head
 *   SHAs, the diffs-agent's analysis reasoning, and why this test was flagged),
 *   the point-in-time refinement-loop lineage, and (for runs) the materialized
 *   scenario data.
 * - **Snapshot scope** (`loadSnapshot`): the same diff-job context gathered
 *   across *all* replayed runs in a snapshot, for agents that reason over the
 *   whole batch at once (resolution) rather than one subject.
 * - **Healing scope** (`loadHealingContext`): the diff-job context for one
 *   refinement iteration's failing subjects (failed generations *and* runs,
 *   supplied by the caller), each carrying its full per-test lineage, the shared
 *   change facts, and its materialized scenario data.
 *
 * This is the only piece of the diff-job path with DB access. It performs no git
 * or filesystem work - the agent derives the changed files and diff hunks itself
 * via `git diff` against the checked-out tree - which keeps the agent run
 * DB-free and the loader trivially testable against a real Postgres.
 *
 * Multimedia (step screenshots + video) stays referenced by S3 key only; an
 * `EvidenceLoader` rehydrates the bytes at run time. The generation conversation
 * is the one exception: it is text the reviewer inlines into the prompt (and
 * that the eval fixture freezes), so the loader resolves it eagerly from S3
 * here - which is why `loadGeneration` requires a storage provider.
 */
export class DiffJobContextLoader {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly storage?: StorageProvider,
    ) {
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
                                branch: { select: { application: { select: { architecture: true } } } },
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

        const steps: RunStepData[] = outputSteps.map((step) => this.toReplayStep(step));

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
            hasLineage: lineage.length > 0,
            hasScenario: scenario != null,
        });

        return {
            runId: run.id,
            organizationId: run.organizationId,
            testPlanPrompt: run.plan?.prompt ?? "No test plan prompt available",
            testCaseName: run.assignment.testCase.name,
            steps,
            videoS3Key: `run/${runId}/video.webm`,
            finalScreenshotKey,
            architecture: run.assignment.snapshot.branch.application.architecture,
            change,
            lineage,
            scenario,
        };
    }

    /**
     * Map one persisted replay `StepOutput` to the normalized reviewer step
     * shape. The replay run stores every step's result in a single `output` JSON
     * blob with no status column, so the discriminant is the `errorName` the run
     * persister writes only on failure: present means a failed step whose
     * `outcome` is the error message; absent means a successful step whose
     * `output` is the command's structured result. This mirrors the generation
     * path's `StepAttempt` mapping, so both reviewers feed the shared renderer the
     * same shape.
     */
    private toReplayStep(step: ReplayStepOutputRow): RunStepData {
        const overlayPoints = getStepOverlayPoints(step.output);
        const failure = readPersistedFailure(step.output);

        return {
            order: step.order,
            interaction: step.stepInput.interaction,
            params: step.stepInput.params,
            status: failure != null ? "failed" : "success",
            screenshotBeforeKey: step.screenshotBefore ?? undefined,
            screenshotAfterKey: step.screenshotAfter ?? undefined,
            overlayPoints: overlayPoints.length > 0 ? overlayPoints : undefined,
            // Failure attribution on failed steps; the command's structured result on successful ones.
            error: failure?.error,
            errorName: failure?.errorName,
            output: failure == null ? (step.output ?? undefined) : undefined,
        };
    }

    /**
     * Gather everything the generation reviewer needs for a single generation:
     * the executed steps, the agent conversation (downloaded from S3), and the
     * same subject-scoped change facts + point-in-time lineage the replay path
     * gets. The generation reviewer already reasons over the conversation; this
     * widens it with the change + lineage the replay reviewer gained in #804/#805.
     *
     * Steps come from the `StepAttempt` timeline - every attempt in true order,
     * counting failures - so the Step Summary surfaces failed attempts (the most
     * diagnostic moments) the successful-only `StepInput` replay list omits. Each
     * attempt maps to the normalized reviewer step shape: `output` on success,
     * `error` + `errorName` on failure. Generations that predate the `StepAttempt`
     * table have no attempts; for those (and re-captures of them) the loader falls
     * back to the `StepInput` replay list, mapping each step as a success.
     */
    async loadGeneration(generationId: string): Promise<GenerationContext> {
        this.logger.info("Loading generation review context", { generationId });

        if (this.storage == null) {
            throw new Error("DiffJobContextLoader requires a StorageProvider to load a generation conversation");
        }

        const generation = await this.db.testGeneration.findUniqueOrThrow({
            where: { id: generationId },
            select: {
                id: true,
                status: true,
                reasoning: true,
                videoUrl: true,
                finalScreenshot: true,
                conversationUrl: true,
                organizationId: true,
                // Anchors the lineage walk the same way `run.planId` does: this
                // plan locates the generation's refinement iteration.
                testPlanId: true,
                testPlan: { select: { prompt: true, testCaseId: true } },
                snapshot: {
                    select: {
                        headSha: true,
                        baseSha: true,
                        diffsJob: { select: { analysisReasoning: true } },
                        branch: { select: { application: { select: { architecture: true } } } },
                    },
                },
                affectedTest: { select: { affectedReason: true, reasoning: true } },
                // The full attempt timeline (successes and failures), in true
                // order, with the per-attempt diagnostic fields. The preferred
                // source, since it keeps failed attempts visible.
                attempts: {
                    select: {
                        order: true,
                        interaction: true,
                        params: true,
                        status: true,
                        output: true,
                        error: true,
                        errorName: true,
                        screenshotBefore: true,
                        screenshotAfter: true,
                    },
                    orderBy: { order: "asc" },
                },
                // The successful-only StepInput replay list - the fallback source
                // for generations that predate the StepAttempt table (see below).
                steps: {
                    select: {
                        list: {
                            select: {
                                order: true,
                                interaction: true,
                                params: true,
                                screenshotBefore: true,
                                screenshotAfter: true,
                                outputs: { select: { output: true }, take: 1 },
                            },
                            orderBy: { order: "asc" },
                        },
                    },
                },
            },
        });

        const steps = this.resolveGenerationSteps(generationId, generation.attempts, generation.steps?.list ?? []);

        const conversation = await this.loadConversation(generation.conversationUrl);
        const change = this.buildChangeContext(generationId, generation.snapshot, generation.affectedTest);
        const lineage = await this.buildLineage(generationId, generation.testPlanId, generation.testPlan.testCaseId);

        // Resolved + materialized via the shared, agent-agnostic helper so the
        // loader stays DB-only and the generation reviewer reaches parity with
        // replay. Returns undefined (and we omit it) when the generation has no
        // scenario, UP never succeeded, or the graph is empty.
        const scenario = await resolveScenarioDataForGeneration(this.db, generationId);

        this.logger.info("Generation review context loaded", {
            generationId,
            stepCount: steps.length,
            selfReportedStatus: generation.status,
            hasChange: change != null,
            hasLineage: lineage.length > 0,
            hasScenario: scenario != null,
        });

        return {
            generationId: generation.id,
            organizationId: generation.organizationId,
            selfReportedStatus: generation.status,
            testPlanPrompt: generation.testPlan.prompt,
            conversation,
            steps,
            architecture: generation.snapshot.branch.application.architecture,
            reasoning: generation.reasoning ?? undefined,
            videoUrl: generation.videoUrl ?? undefined,
            finalScreenshotKey: generation.finalScreenshot ?? undefined,
            change,
            lineage,
            scenario,
        };
    }

    /**
     * Map a generation's persisted steps to the normalized reviewer step shape,
     * preferring the `StepAttempt` timeline (failures included) and falling back
     * to the successful-only `StepInput` replay list for generations that predate
     * the `StepAttempt` table. The fallback marks every step a success, which is
     * exact: that era only ever persisted successful steps.
     */
    private resolveGenerationSteps(
        generationId: string,
        attempts: readonly GenerationAttemptRow[],
        stepInputs: readonly GenerationStepInputRow[],
    ): GenerationStepData[] {
        if (attempts.length > 0) {
            return attempts.map((attempt) => {
                const overlayPoints = getStepOverlayPoints(attempt.output);
                return {
                    order: attempt.order,
                    interaction: attempt.interaction,
                    params: attempt.params,
                    status: attempt.status,
                    output: attempt.output ?? undefined,
                    error: attempt.error ?? undefined,
                    errorName: attempt.errorName ?? undefined,
                    screenshotBeforeKey: attempt.screenshotBefore ?? undefined,
                    screenshotAfterKey: attempt.screenshotAfter ?? undefined,
                    overlayPoints: overlayPoints.length > 0 ? overlayPoints : undefined,
                };
            });
        }

        if (stepInputs.length > 0) {
            this.logger.info("No StepAttempt rows for generation; falling back to the StepInput replay list", {
                generationId,
                stepInputCount: stepInputs.length,
            });
        }

        return stepInputs.map((input) => {
            const output = input.outputs[0]?.output;
            const overlayPoints = getStepOverlayPoints(output);
            return {
                order: input.order,
                interaction: input.interaction,
                params: input.params,
                status: "success",
                output: output ?? undefined,
                screenshotBeforeKey: input.screenshotBefore ?? undefined,
                screenshotAfterKey: input.screenshotAfter ?? undefined,
                overlayPoints: overlayPoints.length > 0 ? overlayPoints : undefined,
            };
        });
    }

    /**
     * Snapshot-scope sibling of {@link load}: gather the diff-job context across
     * every replayed, flagged run in a snapshot. Resolution reasons over the
     * whole replay batch at once (not a single subject), so it consumes this
     * instead of N separate {@link load} calls; healing reuses the same shape.
     *
     * Returns the snapshot-level facts once - the diff anchor (SHAs) and the
     * diffs-agent's analysis reasoning, which is carried independently so it
     * survives a SHA-less snapshot - plus one
     * {@link SnapshotRunContext} per flagged run carrying why the test was
     * flagged, the reviewer's completed verdict (if any), the run's materialized
     * scenario data, and its point-in-time lineage (virtually always empty here,
     * since resolution runs before any refinement loop). Every replayed run is
     * returned regardless of outcome - the consumer filters for actionability.
     *
     * `baselineSnapshotId` selects which snapshot the per-test quarantine gate is
     * read from. It defaults to `snapshotId` (correct at production runtime,
     * before resolution's own `reportBug` quarantines anything); the eval-capture
     * path passes the *previous* snapshot to recover the unmutated baseline after
     * the pipeline has run. Quarantine is the only field affected, so it is the
     * only one the override touches.
     */
    async loadSnapshot(snapshotId: string, opts?: { baselineSnapshotId?: string }): Promise<SnapshotContext> {
        const baselineSnapshotId = opts?.baselineSnapshotId ?? snapshotId;
        this.logger.info("Loading snapshot-scope diff-job context", { snapshotId, baselineSnapshotId });

        const snapshot = await this.db.branchSnapshot.findUniqueOrThrow({
            where: { id: snapshotId },
            select: {
                headSha: true,
                baseSha: true,
                branch: { select: { organizationId: true } },
                diffsJob: { select: { analysisReasoning: true } },
            },
        });

        const affectedTests = await this.db.affectedTest.findMany({
            where: { snapshotId, runId: { not: null } },
            select: {
                affectedReason: true,
                reasoning: true,
                testCase: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                        // The quarantine gate is read from the *baseline* snapshot's
                        // assignment - see the doc comment on baselineSnapshotId.
                        assignments: {
                            where: { snapshotId: baselineSnapshotId },
                            select: { quarantineIssueId: true },
                        },
                    },
                },
                run: {
                    select: {
                        id: true,
                        status: true,
                        // The plan the run actually executed (point-in-time), not the
                        // assignment's possibly-repointed plan - mirrors `load`.
                        planId: true,
                        plan: { select: { prompt: true } },
                        runReview: {
                            select: {
                                status: true,
                                verdict: true,
                                reasoning: true,
                                issue: { select: { title: true, description: true } },
                            },
                        },
                    },
                },
            },
        });

        const change = this.buildSnapshotChange(snapshotId, snapshot);

        // Each run's scenario + lineage are independent DB resolutions, so gather
        // them concurrently across runs (and within a run) rather than serially.
        const runs = (
            await Promise.all(
                affectedTests.map(async (affected): Promise<SnapshotRunContext | undefined> => {
                    const run = affected.run;
                    if (run == null) return undefined;

                    const [scenario, lineage] = await Promise.all([
                        resolveScenarioDataForRun(this.db, run.id),
                        this.buildLineage(run.id, run.planId, affected.testCase.id),
                    ]);

                    const completedReview = run.runReview?.status === "completed" ? run.runReview : undefined;
                    const review: SnapshotRunReview | undefined =
                        completedReview == null
                            ? undefined
                            : {
                                  reasoning: completedReview.reasoning ?? "",
                                  verdict: completedReview.verdict ?? undefined,
                                  issueTitle: completedReview.issue?.title ?? undefined,
                                  issueDescription: completedReview.issue?.description ?? undefined,
                              };

                    return {
                        runId: run.id,
                        testCaseId: affected.testCase.id,
                        testSlug: affected.testCase.slug,
                        testName: affected.testCase.name,
                        testPlanPrompt: run.plan?.prompt ?? "",
                        runStatus: run.status,
                        quarantined: affected.testCase.assignments[0]?.quarantineIssueId != null,
                        affectedReason: affected.affectedReason,
                        affectedReasoning: affected.reasoning,
                        review,
                        scenario,
                        lineage,
                    };
                }),
            )
        ).filter((run): run is SnapshotRunContext => run != null);

        // Always set post-analysis; the null collapses the unreachable states.
        const analysisReasoning = snapshot.diffsJob?.analysisReasoning ?? "";

        this.logger.info("Snapshot-scope diff-job context loaded", {
            snapshotId,
            runCount: runs.length,
            hasChange: change != null,
            hasAnalysisReasoning: analysisReasoning.length > 0,
            runsWithScenario: runs.filter((r) => r.scenario != null).length,
        });

        return {
            snapshotId,
            organizationId: snapshot.branch.organizationId,
            runs,
            change,
            // Analysis reasoning is a snapshot-level fact, not part of the diff
            // anchor: it is carried even when the SHAs (and thus `change`) are absent.
            analysisReasoning,
        };
    }

    /**
     * Healing-scope sibling of {@link loadSnapshot}: gather the unified diff-job
     * context for one refinement iteration's failing subjects. The healing agent
     * runs over a batch of failures (some failed at generation, some at replay),
     * so it consumes this instead of N per-subject {@link load} calls.
     *
     * Unlike {@link loadSnapshot}, the failing subjects are *supplied* by the
     * caller rather than discovered from `AffectedTest`: a healing iteration's
     * failures include generation-stage failures that have no run, and the
     * workflow already bucketed exactly which subjects failed this iteration.
     *
     * Returns the snapshot-level facts once - the diff anchor (SHAs) and the
     * diffs-agent's analysis reasoning (carried independently so it survives a
     * SHA-less snapshot) - plus one {@link HealingSubjectContext} per supplied
     * subject, keyed back by `failureKey`, carrying why the test was flagged, its
     * point-in-time refinement lineage (the highest-value addition for the
     * iterative agent), and its materialized scenario data. Each per-subject
     * field is gathered with the same shared helpers the reviewers and resolution
     * use, so healing consumes exactly the same context they do.
     */
    async loadHealingContext(params: {
        snapshotId: string;
        subjects: readonly HealingFailureSubject[];
    }): Promise<HealingContext> {
        const { snapshotId, subjects } = params;
        this.logger.info("Loading healing-scope diff-job context", { snapshotId, subjectCount: subjects.length });

        const snapshot = await this.db.branchSnapshot.findUniqueOrThrow({
            where: { id: snapshotId },
            select: {
                headSha: true,
                baseSha: true,
                branch: { select: { organizationId: true, applicationId: true } },
                diffsJob: { select: { analysisReasoning: true } },
            },
        });

        const change = this.buildSnapshotChange(snapshotId, snapshot);
        // Always set post-analysis; the null collapses the unreachable states.
        const analysisReasoning = snapshot.diffsJob?.analysisReasoning ?? "";

        // One AffectedTest per (snapshot, testCase), so the per-test flag facts
        // are read in a single batched query keyed by the subjects' test cases.
        const testCaseIds = [...new Set(subjects.map((subject) => subject.testCaseId))];
        const affectedTests = await this.db.affectedTest.findMany({
            where: { snapshotId, testCaseId: { in: testCaseIds } },
            select: { testCaseId: true, affectedReason: true, reasoning: true },
        });
        const affectedByTestCase = new Map(affectedTests.map((affected) => [affected.testCaseId, affected]));

        // Each subject's scenario + lineage are independent DB resolutions, so
        // gather them concurrently across subjects (and within a subject).
        const subjectContexts = await Promise.all(
            subjects.map(async (subject): Promise<HealingSubjectContext> => {
                const [scenario, lineage] = await Promise.all([
                    this.resolveSubjectScenario(subject),
                    this.buildLineage(subject.sourceId, subject.planId, subject.testCaseId),
                ]);

                const affected = affectedByTestCase.get(subject.testCaseId);
                return {
                    failureKey: subject.failureKey,
                    affectedReason: affected?.affectedReason,
                    affectedReasoning: affected?.reasoning,
                    lineage,
                    scenario,
                };
            }),
        );

        this.logger.info("Healing-scope diff-job context loaded", {
            snapshotId,
            subjectCount: subjectContexts.length,
            hasChange: change != null,
            hasAnalysisReasoning: analysisReasoning.length > 0,
            subjectsWithLineage: subjectContexts.filter((subject) => subject.lineage.length > 0).length,
            subjectsWithScenario: subjectContexts.filter((subject) => subject.scenario != null).length,
        });

        return {
            snapshotId,
            organizationId: snapshot.branch.organizationId,
            applicationId: snapshot.branch.applicationId,
            subjects: subjectContexts,
            change,
            analysisReasoning,
        };
    }

    /**
     * Resolve the materialized scenario data for one healing subject via the
     * source-appropriate shared helper: a generation failure resolves from its
     * generation, a replay failure from its run.
     */
    private resolveSubjectScenario(subject: HealingFailureSubject): Promise<ScenarioData | undefined> {
        if (subject.source === "generation") {
            return resolveScenarioDataForGeneration(this.db, subject.sourceId);
        }
        return resolveScenarioDataForRun(this.db, subject.sourceId);
    }

    /**
     * Assemble the snapshot's diff anchor (base/head SHAs) shared by every run.
     * Returns `undefined` when the snapshot is missing its SHAs - without them
     * there is nothing to `git diff` against, matching {@link buildChangeContext}'s
     * per-subject behavior. Analysis reasoning is deliberately *not* gated on this:
     * it is a snapshot-level fact handled separately by {@link loadSnapshot}.
     */
    private buildSnapshotChange(snapshotId: string, snapshot: ChangeSnapshot): SnapshotChangeContext | undefined {
        if (snapshot.baseSha == null || snapshot.headSha == null) {
            this.logger.warn("Snapshot is missing base/head SHA - omitting change context", { snapshotId });
            return undefined;
        }

        return { baseSha: snapshot.baseSha, headSha: snapshot.headSha };
    }

    private async loadConversation(conversationUrl: string | null): Promise<ModelMessage[]> {
        if (this.storage == null) {
            throw new Error("DiffJobContextLoader requires a StorageProvider to load a generation conversation");
        }
        if (conversationUrl == null) {
            this.logger.warn("No conversation URL found - returning empty conversation");
            return [];
        }
        this.logger.info("Downloading execution conversation", { conversationUrl });
        const buffer = await this.storage.download(conversationUrl);
        const parsed: unknown = JSON.parse(buffer.toString("utf-8"));
        if (!Array.isArray(parsed)) {
            this.logger.warn("Downloaded conversation is not an array - returning empty conversation", {
                conversationUrl,
            });
            return [];
        }
        return parsed;
    }

    /**
     * Gather the subject test's point-in-time refinement-loop history: one entry
     * per iteration (oldest first, up to and including the iteration this subject
     * executed) carrying the plan that iteration scoped and the verdicts its runs
     * reached.
     *
     * "Point-in-time" is enforced two ways: the history is capped at the subject's
     * own iteration number (later iterations may already exist in the DB by the
     * time a re-review runs, but they did not exist when this subject executed),
     * and only `completed` reviews from *earlier* iterations contribute verdicts -
     * the subject's own iteration carries no verdict (its review is in progress).
     *
     * Empty when there is nothing to show: the subject isn't part of a refinement
     * loop, or it's a first-iteration subject (no earlier iterations).
     */
    private async buildLineage(
        subjectId: string,
        planId: string | null,
        testCaseId: string,
    ): Promise<IterationLineage[]> {
        if (planId == null) return [];

        // The subject's executed plan is the analysis-scope input to exactly one
        // refinement iteration; that iteration's number and loop bound the walk.
        const subjectInput = await this.db.refinementIterationInput.findFirst({
            where: { planId },
            select: { iteration: { select: { number: true, loopId: true } } },
        });
        if (subjectInput == null) {
            this.logger.info("Subject is not part of a refinement loop - no lineage", { subjectId });
            return [];
        }

        const { number: subjectNumber, loopId } = subjectInput.iteration;
        if (subjectNumber <= 1) {
            this.logger.info("First-iteration subject - no lineage", { subjectId, iteration: subjectNumber });
            return [];
        }

        // Every plan this test was scoped to from the seed iteration through the
        // subject's own iteration. Capping at `subjectNumber` keeps the view
        // point-in-time even if later iterations already exist in the DB.
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

        const planIds = inputs.map((input) => input.plan.id);
        const [rewriteReasoning, verdictsByIteration] = await Promise.all([
            this.loadRewriteReasoning(loopId, planIds),
            this.loadVerdictsByIteration(inputs, subjectNumber),
        ]);

        const lineage = inputs.map((input) => ({
            iterationNumber: input.iteration.number,
            prompt: input.plan.prompt,
            healingReasoning: rewriteReasoning.get(input.plan.id) ?? undefined,
            verdicts: verdictsByIteration.get(input.iteration.number) ?? [],
        }));

        this.logger.info("Gathered review lineage", {
            subjectId,
            iteration: subjectNumber,
            iterations: lineage.length,
        });

        return lineage;
    }

    /**
     * The `update_plan` healing reasoning per plan id, from the action that created
     * each plan. The seed plan (iteration 1) has none.
     */
    private async loadRewriteReasoning(loopId: string, planIds: string[]): Promise<Map<string, string>> {
        const actions = await this.db.refinementAction.findMany({
            where: { kind: "update_plan", planId: { in: planIds }, iteration: { loopId } },
            select: { planId: true, reasoning: true },
        });
        const reasoningByPlanId = new Map<string, string>();
        for (const action of actions) {
            if (action.planId != null) reasoningByPlanId.set(action.planId, action.reasoning);
        }
        return reasoningByPlanId;
    }

    /**
     * The completed verdicts each *earlier* iteration's runs reached on this test,
     * keyed by iteration number (oldest-first within each, by run creation). The
     * subject iteration's own runs are excluded - that's the review in progress.
     */
    private async loadVerdictsByIteration(
        inputs: IterationPlanInput[],
        subjectNumber: number,
    ): Promise<Map<number, IterationVerdict[]>> {
        const byIteration = new Map<number, IterationVerdict[]>();

        const earlierInputs = inputs.filter((input) => input.iteration.number < subjectNumber);
        if (earlierInputs.length === 0) return byIteration;

        const iterationByPlanId = new Map(earlierInputs.map((input) => [input.plan.id, input.iteration.number]));

        const priorRuns = await this.db.run.findMany({
            where: {
                planId: { in: earlierInputs.map((input) => input.plan.id) },
                runReview: { status: "completed", verdict: { not: null } },
            },
            select: {
                planId: true,
                runReview: { select: { verdict: true, reasoning: true } },
            },
            orderBy: { createdAt: "asc" },
        });

        for (const run of priorRuns) {
            const verdict = run.runReview?.verdict;
            if (run.planId == null || verdict == null) continue;
            const iterationNumber = iterationByPlanId.get(run.planId);
            if (iterationNumber == null) continue;
            const verdicts = byIteration.get(iterationNumber) ?? [];
            verdicts.push({ verdict, reasoning: run.runReview?.reasoning ?? "" });
            byIteration.set(iterationNumber, verdicts);
        }

        return byIteration;
    }

    /**
     * Assemble the subject-scoped change facts. Returns `undefined` when the
     * snapshot is missing its SHAs - without them the reviewer has nothing to
     * `git diff` against, so the change section would be useless. The affected-test
     * fields stay individually optional: a subject may not be a flagged test.
     */
    private buildChangeContext(
        subjectId: string,
        snapshot: ChangeSnapshot,
        affectedTest: { affectedReason: ChangeContext["affectedReason"]; reasoning: string } | null,
    ): ChangeContext | undefined {
        if (snapshot.baseSha == null || snapshot.headSha == null) {
            this.logger.warn("Snapshot is missing base/head SHA - omitting change context from review", {
                subjectId,
            });
            return undefined;
        }

        return {
            baseSha: snapshot.baseSha,
            headSha: snapshot.headSha,
            // Always set post-analysis; the null collapses the unreachable
            // states (and a missing DiffsJob) to the empty-summary case.
            analysisReasoning: snapshot.diffsJob?.analysisReasoning ?? "",
            affectedReason: affectedTest?.affectedReason,
            affectedReasoning: affectedTest?.reasoning,
        };
    }
}

/**
 * Read the failure attribution a replay step's persisted `output` carries, or
 * `undefined` when the step succeeded. The run persister writes a string
 * `errorName` only on failure (alongside the error message under `outcome`), and
 * no successful command output ever carries an `errorName` field - so a string
 * `errorName` is an exact failure discriminant.
 */
function readPersistedFailure(output: unknown): { error?: string; errorName: string } | undefined {
    if (!isRecord(output)) return undefined;

    const errorName = output["errorName"];
    if (typeof errorName !== "string") return undefined;

    const outcome = output["outcome"];
    return { errorName, error: typeof outcome === "string" ? outcome : undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
