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
    type RenderableReviewStep,
    type ScenarioData,
    type SnapshotChangeContext,
    resolveScenarioDataForGeneration,
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

/**
 * Gathers everything a diff-job agent needs from the database, at one of two
 * scopes:
 *
 * - **Subject scope** (`loadGeneration`): everything the generation reviewer
 *   needs for a single generation - the executed steps + test metadata, the
 *   subject-scoped change context (base/head SHAs, the diffs-agent's analysis
 *   reasoning, and why this test was flagged), the point-in-time refinement-loop
 *   lineage, and the materialized scenario data.
 * - **Healing scope** (`loadHealingContext`): the diff-job context for one
 *   refinement iteration's failing generations, supplied by the caller, each
 *   carrying its full per-test lineage, the shared change facts, and its
 *   materialized scenario data.
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

    /**
     * Gather everything the generation reviewer needs for a single generation:
     * the executed steps, the agent conversation (downloaded from S3), and the
     * subject-scoped change facts + point-in-time lineage. The generation reviewer
     * already reasons over the conversation; this widens it with the change +
     * lineage gained in #804/#805.
     *
     * Steps come from the `StepAttempt` timeline - every attempt in true order,
     * counting failures - so the Step Summary surfaces failed attempts (the most
     * diagnostic moments) the successful-only `StepInput` list omits. Each
     * attempt maps to the normalized reviewer step shape: `output` on success,
     * `error` + `errorName` on failure. Generations that predate the `StepAttempt`
     * table have no attempts; for those (and re-captures of them) the loader falls
     * back to the `StepInput` list, mapping each step as a success.
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
                testPlan: {
                    select: {
                        prompt: true,
                        testCaseId: true,
                        testCase: { select: { name: true, description: true } },
                    },
                },
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
                // order, with the per-attempt diagnostic fields.
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
            },
        });

        const steps = this.resolveGenerationSteps(generation.attempts);

        const conversation = await this.loadConversation(generation.conversationUrl);
        const change = this.buildChangeContext(generationId, generation.snapshot, generation.affectedTest);
        const lineage = await this.buildLineage(generationId, generation.testPlanId, generation.testPlan.testCaseId);

        // Resolved + materialized via the shared, agent-agnostic helper so the
        // loader stays DB-only. Returns undefined (and we omit it) when the
        // generation has no scenario, UP never succeeded, or the graph is empty.
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
            testCaseName: generation.testPlan.testCase.name,
            testCaseDescription: generation.testPlan.testCase.description ?? undefined,
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
     * Map a generation's `StepAttempt` timeline (failures included) to the
     * normalized reviewer step shape.
     */
    private resolveGenerationSteps(attempts: readonly GenerationAttemptRow[]): GenerationStepData[] {
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

    /**
     * Gather the unified diff-job context for one refinement iteration's failing
     * generations. The healing agent runs over a batch of failures, so it
     * consumes this instead of N per-subject calls.
     *
     * The failing subjects are *supplied* by the caller rather than discovered
     * from `AffectedTest`: the workflow already bucketed exactly which subjects
     * failed this iteration.
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

        // Each subject's scenario + lineage + steps are independent DB
        // resolutions, so gather them concurrently across subjects (and within a
        // subject).
        const subjectContexts = await Promise.all(
            subjects.map(async (subject): Promise<HealingSubjectContext> => {
                const [scenario, lineage, steps] = await Promise.all([
                    this.resolveSubjectScenario(subject),
                    this.buildLineage(subject.sourceId, subject.planId, subject.testCaseId),
                    this.loadSubjectSteps(subject),
                ]);

                const affected = affectedByTestCase.get(subject.testCaseId);
                return {
                    failureKey: subject.failureKey,
                    affectedReason: affected?.affectedReason,
                    affectedReasoning: affected?.reasoning,
                    lineage,
                    scenario,
                    steps,
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
            subjectsWithSteps: subjectContexts.filter((subject) => subject.steps.length > 0).length,
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
     * Resolve the materialized scenario data for one healing subject from its
     * failing generation via the shared helper.
     */
    private resolveSubjectScenario(subject: HealingFailureSubject): Promise<ScenarioData | undefined> {
        return resolveScenarioDataForGeneration(this.db, subject.sourceId);
    }

    /**
     * Load one healing subject's executed steps (screenshot keys + step-output
     * text) so the healing agent's `fetch_step_evidence` tool can inspect any
     * step on demand. Sourced the way the reviewer sources its own - the
     * generation `StepAttempt` timeline (failures included) - so the agent sees
     * the same steps the reviewer graded. Only step metadata is loaded here; the
     * screenshot bytes are rehydrated lazily by the tool via the screenshot loader.
     */
    private loadSubjectSteps(subject: HealingFailureSubject): Promise<RenderableReviewStep[]> {
        return this.loadGenerationSteps(subject.sourceId);
    }

    private async loadGenerationSteps(generationId: string): Promise<RenderableReviewStep[]> {
        const generation = await this.db.testGeneration.findUnique({
            where: { id: generationId },
            select: {
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
            },
        });
        if (generation == null) {
            this.logger.warn("Healing subject generation not found - no step evidence", { generationId });
            return [];
        }
        return this.resolveGenerationSteps(generation.attempts);
    }

    /**
     * Assemble the snapshot's diff anchor (base/head SHAs) shared by every
     * subject. Returns `undefined` when the snapshot is missing its SHAs - without
     * them there is nothing to `git diff` against, matching
     * {@link buildChangeContext}'s per-subject behavior. Analysis reasoning is
     * deliberately *not* gated on this: it is a snapshot-level fact carried
     * separately by {@link loadHealingContext}.
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
     * The completed verdicts each *earlier* iteration's generations reached on
     * this test, keyed by iteration number (oldest-first within each, by
     * generation creation). The subject iteration's own generations are excluded -
     * that's the review in progress.
     */
    private async loadVerdictsByIteration(
        inputs: IterationPlanInput[],
        subjectNumber: number,
    ): Promise<Map<number, IterationVerdict[]>> {
        const byIteration = new Map<number, IterationVerdict[]>();

        const earlierInputs = inputs.filter((input) => input.iteration.number < subjectNumber);
        if (earlierInputs.length === 0) return byIteration;

        const iterationByPlanId = new Map(earlierInputs.map((input) => [input.plan.id, input.iteration.number]));

        const priorGenerations = await this.db.testGeneration.findMany({
            where: {
                testPlanId: { in: earlierInputs.map((input) => input.plan.id) },
                shadow: false,
                generationReview: { status: "completed", verdict: { not: null } },
            },
            select: {
                testPlanId: true,
                generationReview: { select: { verdict: true, reasoning: true } },
            },
            orderBy: { createdAt: "asc" },
        });

        for (const generation of priorGenerations) {
            const verdict = generation.generationReview?.verdict;
            if (verdict == null) continue;
            const iterationNumber = iterationByPlanId.get(generation.testPlanId);
            if (iterationNumber == null) continue;
            const verdicts = byIteration.get(iterationNumber) ?? [];
            verdicts.push({ verdict, reasoning: generation.generationReview?.reasoning ?? "" });
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
