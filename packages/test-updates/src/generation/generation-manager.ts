import type { GenerationStatus, PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { WorkflowArchitecture } from "@autonoma/workflow";
import type { FiredBatch, GenerationProvider, PendingGeneration } from "./generation-job-provider";

export class MissingJobProviderError extends Error {
    constructor() {
        super("Cannot queue generations without a job provider");
        this.name = "MissingJobProviderError";
    }
}

export interface GenerationManagerParams {
    snapshotId: string;
    organizationId: string;
    db: PrismaClient;
    jobProvider?: GenerationProvider;
}

interface QuarantineSummary {
    quarantineIssueId: string | null;
    quarantineIssue: {
        kind: "application_bug" | "engine_limitation";
        bugId: string | null;
    } | null;
}

interface SnapshotGeneration {
    id: string;
    status: GenerationStatus;
    stepsId: string | null;
    testPlanId: string;
    createdAt: Date;
    testPlan: {
        testCaseId: string;
        scenario: { id: string } | null;
        testCase: {
            application: { architecture: string };
            assignments: QuarantineSummary[];
        };
    };
}

const INCOMPLETE_STATUSES: GenerationStatus[] = ["pending", "queued", "running"];

interface PendingGenerationWithQuarantine extends PendingGeneration {
    quarantine: QuarantineSummary | undefined;
}

function stripQuarantineContext(gen: PendingGenerationWithQuarantine): PendingGeneration {
    return {
        testGenerationId: gen.testGenerationId,
        planId: gen.planId,
        scenarioId: gen.scenarioId,
        architecture: gen.architecture,
    };
}

abstract class DeploymentConfigurationError extends Error {
    abstract readonly userMessage: string;
}

export class NoDeploymentConfiguredError extends DeploymentConfigurationError {
    readonly userMessage =
        "No deployment configured for this branch. Please configure a deployment in your application settings.";

    constructor() {
        super("No deployment configured for this branch");
    }
}

export class NoWebDeploymentError extends DeploymentConfigurationError {
    readonly userMessage =
        "Can't run web tests: no web deployment configured for this branch. Please configure a web deployment in your application settings.";

    constructor() {
        super("Can't run web tests: no web deployment configured for this branch");
    }
}

export class NoMobileDeploymentError extends DeploymentConfigurationError {
    readonly userMessage =
        "Can't run mobile tests: no mobile deployment configured for this branch. Please configure a mobile deployment in your application settings.";

    constructor() {
        super("Can't run mobile tests: no mobile deployment configured for this branch");
    }
}

/**
 * Manages the state of generations for a snapshot.
 *
 * All read methods fetch the full list of generations for the snapshot and filter
 * in memory. We expect fewer than 1000 generations per snapshot, so it is safe to
 * load them all at once.
 */
export class GenerationManager {
    private readonly logger: Logger;

    private readonly snapshotId: string;
    private readonly organizationId: string;
    private readonly db: PrismaClient;
    private readonly jobProvider?: GenerationProvider;

    constructor({ snapshotId, organizationId, db, jobProvider }: GenerationManagerParams) {
        this.snapshotId = snapshotId;
        this.organizationId = organizationId;
        this.db = db;
        this.jobProvider = jobProvider;
        this.logger = logger.child({ name: this.constructor.name, snapshotId });
    }

    /**
     * Schedule a generation job with the given test plan.
     *
     * This doesn't immediately start the job - it only stores the data for later execution.
     * Deletes any existing pending generations for the same test case before creating the new one.
     */
    async addJob(planId: string) {
        this.logger.info("Adding job to queue", { planId });

        const generations = await this.fetchGenerations();
        const testCaseId = await this.resolveTestCaseId(planId);

        const existingGenerations = generations.filter(
            (gen) => gen.testPlan.testCaseId === testCaseId && gen.status === "pending",
        );

        if (existingGenerations.length > 0) {
            const existingGenerationIds = existingGenerations.map((gen) => gen.id);
            this.logger.info("Found existing pending generations for test case", {
                planId,
                testCaseId,
                existingGenerationIds,
            });

            const generationsWithDifferentPlans = existingGenerations.filter((gen) => gen.testPlanId !== planId);
            if (generationsWithDifferentPlans.length > 0) {
                this.logger.fatal(
                    "Found generations with different test plans for this test case. This is likely an error",
                    { planId },
                );
            }

            this.logger.info("Deleting pending generations for this test case", { planId });
            await this.db.testGeneration.deleteMany({ where: { id: { in: existingGenerationIds } } });
        }

        this.logger.info("Creating generation record", { planId });
        await this.db.testGeneration.create({
            data: {
                testPlanId: planId,
                snapshotId: this.snapshotId,
                organizationId: this.organizationId,
            },
        });
    }

    /** Returns all pending generation records for this snapshot. */
    async getPendingGenerations() {
        const generations = await this.fetchGenerations();

        return generations
            .filter((gen) => gen.status === "pending")
            .map((gen) => ({
                testGenerationId: gen.id,
                planId: gen.testPlanId,
                scenarioId: gen.testPlan.scenario?.id,
                architecture: gen.testPlan.testCase.application.architecture as WorkflowArchitecture,
            }));
    }

    /** Returns the generations matching the given IDs. */
    async getGenerations(generationIds: string[]) {
        const idSet = new Set(generationIds);
        const generations = await this.fetchGenerations();

        return generations.filter((gen) => idSet.has(gen.id));
    }

    /** Deletes a pending generation. Throws if the generation is not pending. */
    async discardGeneration(generationId: string) {
        this.logger.info("Discarding generation", { generationId });

        const generation = await this.db.testGeneration.findUnique({
            where: { id: generationId, snapshotId: this.snapshotId },
            select: { status: true },
        });

        if (generation == null) {
            throw new Error(`Generation ${generationId} not found for snapshot ${this.snapshotId}`);
        }

        if (generation.status !== "pending") {
            throw new Error(
                `Cannot discard generation ${generationId}: status is "${generation.status}", expected "pending"`,
            );
        }

        await this.db.testGeneration.delete({ where: { id: generationId } });
        this.logger.info("Generation discarded", { generationId });
    }

    /** Returns true if there are any incomplete (pending, queued, or running) generations for this snapshot. */
    async hasIncompleteGenerations() {
        const generations = await this.fetchGenerations();

        return generations.some((gen) => INCOMPLETE_STATUSES.includes(gen.status));
    }

    /** Returns the latest generation status per test case for this snapshot. */
    async getGenerationSummary() {
        const generations = await this.fetchGenerations();

        const latestByTestCase = new Map<string, SnapshotGeneration>();
        for (const gen of generations) {
            const existing = latestByTestCase.get(gen.testPlan.testCaseId);
            if (existing == null || gen.createdAt > existing.createdAt)
                latestByTestCase.set(gen.testPlan.testCaseId, gen);
        }

        return Array.from(latestByTestCase.values()).map((gen) => ({
            testCaseId: gen.testPlan.testCaseId,
            generationId: gen.id,
            status: gen.status,
        }));
    }

    /**
     * Validates deployment, marks pending generations as queued, and returns
     * the list ready for dispatch. Does NOT fire any jobs - callers that need
     * to start a workflow per generation do that themselves (see
     * `queuePendingGenerations` for the fire-and-forget HTTP path).
     *
     * If validation fails, marks all pending generations as failed and returns
     * an empty list.
     */
    async prepareGenerationQueue(): Promise<PendingGeneration[]> {
        const pending = await this.getPendingGenerationsWithContext();

        if (pending.length === 0) {
            this.logger.info("No pending generations to prepare");
            return [];
        }
        this.logger.info("Preparing generation queue", { count: pending.length });

        const allowed = await this.filterOutQuarantined(pending);
        if (allowed.length === 0) {
            this.logger.info("All pending generations were quarantined; nothing to queue");
            return [];
        }

        try {
            await this.validateDeploymentForGenerations(allowed);
        } catch (error) {
            this.logger.fatal("Deployment validation failed", error, {
                count: allowed.length,
                generationIds: allowed.map((g) => g.testGenerationId),
            });

            await this.markAsFailed(
                allowed.map((g) => g.testGenerationId),
                error instanceof DeploymentConfigurationError
                    ? error.userMessage
                    : "Unknown error. Contact the Autonoma team for help.",
            );

            return [];
        }

        await this.markAsQueued(allowed.map((g) => g.testGenerationId));

        this.logger.info("Generation queue prepared", { count: allowed.length });

        return allowed;
    }

    /**
     * Excludes any pending generations whose test case is quarantined for this
     * snapshot. Excluded generations are marked as failed with reasoning citing
     * the linked Bug/Issue id.
     */
    private async filterOutQuarantined(
        pending: ReadonlyArray<PendingGenerationWithQuarantine>,
    ): Promise<PendingGeneration[]> {
        const allowed: PendingGeneration[] = [];
        const quarantined: { id: string; reasoning: string }[] = [];

        for (const gen of pending) {
            const issue = gen.quarantine?.quarantineIssue;
            if (issue == null) {
                allowed.push(stripQuarantineContext(gen));
                continue;
            }

            const link =
                issue.bugId != null ? `Bug ${issue.bugId}` : `Issue ${gen.quarantine?.quarantineIssueId ?? "?"}`;
            quarantined.push({
                id: gen.testGenerationId,
                reasoning: `Quarantined: ${issue.kind} (${link})`,
            });
        }

        if (quarantined.length > 0) {
            this.logger.info("Skipping quarantined generations", {
                count: quarantined.length,
                generationIds: quarantined.map((g) => g.id),
            });
            await this.markEachAsFailed(quarantined);
        }

        return allowed;
    }

    /** Same as getPendingGenerations but also returns the assignment's quarantine state. */
    private async getPendingGenerationsWithContext(): Promise<PendingGenerationWithQuarantine[]> {
        const generations = await this.fetchGenerations();

        return generations
            .filter((gen) => gen.status === "pending")
            .map((gen) => ({
                testGenerationId: gen.id,
                planId: gen.testPlanId,
                scenarioId: gen.testPlan.scenario?.id,
                architecture: gen.testPlan.testCase.application.architecture as WorkflowArchitecture,
                quarantine: gen.testPlan.testCase.assignments[0],
            }));
    }

    /**
     * Fires generation jobs for all pending generations and marks them as queued.
     *
     * Validates deployment configuration before firing. If validation fails,
     * marks all pending generations as failed. For workflow callers that need to
     * dispatch the batch themselves, see `prepareGenerationQueue`.
     *
     * @returns Whether any generations were queued.
     * @throws {MissingJobProviderError} If no job provider was supplied at construction time.
     */
    async queuePendingGenerations(): Promise<{ generationsQueued: boolean; batch?: FiredBatch }> {
        if (this.jobProvider == null) throw new MissingJobProviderError();

        const prepared = await this.prepareGenerationQueue();
        if (prepared.length === 0) {
            return { generationsQueued: false };
        }
        this.logger.info("Firing generation jobs", { count: prepared.length });

        let batch: FiredBatch;
        try {
            batch = await this.jobProvider.fireJobs(this.snapshotId, prepared);
        } catch (error) {
            this.logger.fatal("Failed to fire generation jobs", error, {
                count: prepared.length,
                generationIds: prepared.map((g) => g.testGenerationId),
            });

            await this.markAsFailed(
                prepared.map((g) => g.testGenerationId),
                "Unknown error. Contact the Autonoma team for help.",
            );

            return { generationsQueued: false };
        }

        this.logger.info("Generation jobs fired", { count: prepared.length });

        return { generationsQueued: true, batch };
    }

    /** Marks the given generations as failed with the given reasoning. */
    private async markAsFailed(generationIds: string[], reasoning: string) {
        this.logger.info("Marking generations as failed", { generationIds, reasoning });

        await this.db.testGeneration.updateMany({
            where: { id: { in: generationIds }, snapshotId: this.snapshotId },
            data: { status: "failed", reasoning },
        });
    }

    /** Marks each generation as failed with its own reasoning. */
    private async markEachAsFailed(entries: ReadonlyArray<{ id: string; reasoning: string }>) {
        await this.db.$transaction(
            entries.map((entry) =>
                this.db.testGeneration.update({
                    where: { id: entry.id, snapshotId: this.snapshotId },
                    data: { status: "failed", reasoning: entry.reasoning },
                }),
            ),
        );
    }

    /** Marks the given generations as queued. */
    private async markAsQueued(generationIds: string[]) {
        this.logger.info("Marking generations as queued", { generationIds });

        await this.db.testGeneration.updateMany({
            where: { id: { in: generationIds }, snapshotId: this.snapshotId },
            data: { status: "queued" },
        });
    }

    /**
     * Validates that the snapshot's deployment is properly configured for the
     * given generations. Returns an error message if validation fails, or
     * `undefined` if the deployment is valid.
     */
    private async validateDeploymentForGenerations(pending: readonly PendingGeneration[]): Promise<string | undefined> {
        this.logger.info("Validating deployment for generations", { snapshotId: this.snapshotId });

        const snapshot = await this.db.branchSnapshot.findUnique({
            where: { id: this.snapshotId },
            select: {
                branch: {
                    select: {
                        deployment: {
                            select: {
                                webDeployment: { select: { url: true } },
                                mobileDeployment: { select: { deploymentId: true } },
                            },
                        },
                    },
                },
            },
        });

        const deployment = snapshot?.branch.deployment;
        if (deployment == null) {
            throw new NoDeploymentConfiguredError();
        }

        const architectures = new Set(pending.map((g) => g.architecture));

        if (architectures.has("WEB")) {
            const webUrl = deployment.webDeployment?.url;
            if (webUrl == null || webUrl === "") throw new NoWebDeploymentError();
        }

        if (architectures.has("IOS") || architectures.has("ANDROID")) {
            if (deployment.mobileDeployment == null) throw new NoMobileDeploymentError();
        }

        this.logger.info("Deployment validation passed", { snapshotId: this.snapshotId });
        return undefined;
    }

    /**
     * Fetches all generations for this snapshot.
     *
     * We expect fewer than 1000 generations per snapshot, so it is safe to load
     * them all into memory at once.
     */
    private async fetchGenerations() {
        return this.db.testGeneration.findMany({
            where: { snapshotId: this.snapshotId },
            select: {
                id: true,
                status: true,
                stepsId: true,
                testPlanId: true,
                createdAt: true,
                testPlan: {
                    select: {
                        testCaseId: true,
                        scenario: { select: { id: true } },
                        testCase: {
                            select: {
                                application: { select: { architecture: true } },
                                assignments: {
                                    where: { snapshotId: this.snapshotId },
                                    select: {
                                        quarantineIssueId: true,
                                        quarantineIssue: { select: { kind: true, bugId: true } },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
    }

    private async resolveTestCaseId(planId: string) {
        const plan = await this.db.testPlan.findUniqueOrThrow({
            where: { id: planId },
            select: { testCaseId: true },
        });
        return plan.testCaseId;
    }
}
