import { randomBytes } from "node:crypto";
import matter from "@11ty/gray-matter";
import type { Prisma, PrismaClient } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { logger } from "@autonoma/logger";
import type { ScenarioRecipeStore } from "@autonoma/scenario";
import {
    AddTest,
    BranchAlreadyHasPendingSnapshotError,
    type GenerationProvider,
    TestSuiteUpdater,
    fetchTestSuiteInfo,
} from "@autonoma/test-updates";
import {
    type SetupEventBody,
    type UpdateSetupBody,
    type UploadArtifactsBody,
    type UploadScenarioRecipeVersionsBody,
    TestCaseFrontmatterSchema,
    TOTAL_SETUP_STEPS,
} from "@autonoma/types";
import { toSlug } from "@autonoma/utils";
import type { OnboardingManager } from "../routes/onboarding/onboarding-manager";

const log = logger.child({ name: "ApplicationSetupService" });

function buildArtifactPath(file: { name: string; folder?: string }) {
    return file.folder != null ? `${file.folder}/${file.name}` : file.name;
}

const SCENARIO_RECIPES_ARTIFACT_PATH = "autonoma/scenario-recipes.json";

type SetupWithBranch = {
    id: string;
    applicationId: string;
    application: {
        mainBranch: {
            id: string;
            activeSnapshot: { id: string } | null;
            pendingSnapshot: { id: string } | null;
        } | null;
    };
};

export class ApplicationSetupService {
    constructor(
        private readonly db: PrismaClient,
        private readonly generationProvider: GenerationProvider,
        private readonly onboardingManager: OnboardingManager,
        private readonly recipeStore: ScenarioRecipeStore,
    ) {}

    async createSetup(userId: string, organizationId: string, applicationId: string, repoName?: string) {
        const setup = await this.db.$transaction(async (tx) => {
            const app = await tx.application.findUnique({ where: { id: applicationId, organizationId } });
            if (app == null) throw new NotFoundError("Application not found");

            if (repoName != null) {
                const uniqueName = await this.resolveUniqueName(tx, repoName, organizationId);
                await tx.application.update({
                    where: { id: applicationId },
                    data: { name: uniqueName, slug: toSlug(uniqueName) },
                });
            }

            return tx.applicationSetup.create({
                data: {
                    applicationId,
                    organizationId,
                    userId,
                    totalSteps: TOTAL_SETUP_STEPS,
                },
            });
        });

        log.info("Created application setup", { setupId: setup.id, applicationId });
        return { id: setup.id, applicationId };
    }

    private async resolveUniqueName(
        tx: Prisma.TransactionClient,
        name: string,
        organizationId: string,
    ): Promise<string> {
        const existing = await tx.application.findUnique({
            where: { name_organizationId: { name, organizationId } },
            select: { id: true },
        });
        if (existing == null) return name;

        const suffix = randomBytes(6).toString("hex");
        const uniqueName = `${name}-${suffix}`;
        log.info("Application name conflict, appending suffix", { originalName: name, uniqueName });
        return uniqueName;
    }

    async addEvent(setupId: string, organizationId: string, event: SetupEventBody) {
        let setupCompleted = false;
        let applicationId: string | undefined;

        await this.db.$transaction(async (tx) => {
            const found = await tx.applicationSetup.findUnique({
                where: { id: setupId, organizationId },
                select: { id: true, applicationId: true },
            });
            if (found == null) throw new NotFoundError("Application setup not found");

            applicationId = found.applicationId;

            await tx.applicationSetupEvent.create({
                data: {
                    setupId,
                    type: event.type,
                    data: event.data as Record<string, unknown>,
                },
            });

            if (event.type === "step.started") {
                await tx.applicationSetup.update({
                    where: { id: setupId },
                    data: { currentStep: event.data.step },
                });
            }

            if (event.type === "step.completed" && event.data.step === TOTAL_SETUP_STEPS - 1) {
                await tx.applicationSetup.update({
                    where: { id: setupId },
                    data: { status: "completed", completedAt: new Date() },
                });
                setupCompleted = true;
            }

            if (event.type === "error") {
                await tx.applicationSetup.update({
                    where: { id: setupId },
                    data: { status: "failed", errorMessage: event.data.message },
                });
            }

            return found;
        });

        if (setupCompleted && applicationId != null) {
            await this.activateSnapshotAfterSetupCompletion(setupId, applicationId, organizationId);
        }

        log.info("Added setup event", { setupId, type: event.type });
    }

    async updateSetup(setupId: string, organizationId: string, body: UpdateSetupBody) {
        let setupCompleted = false;
        let applicationId: string | undefined;

        await this.db.$transaction(async (tx) => {
            const setup = await tx.applicationSetup.findUnique({ where: { id: setupId, organizationId } });
            if (setup == null) throw new NotFoundError("Application setup not found");
            applicationId = setup.applicationId;

            const data: Record<string, unknown> = {};
            if (body.name != null) data.name = body.name;
            if (body.status === "completed") {
                data.status = "completed";
                data.completedAt = new Date();
                setupCompleted = true;
            }
            if (body.status === "partial_failure") {
                data.status = "partial_failure";
                data.errorMessage = body.errorMessage;
                data.completedAt = null;
            }
            if (body.status === "failed") {
                data.status = "failed";
                data.errorMessage = body.errorMessage;
                data.completedAt = null;
            }

            await tx.applicationSetup.update({
                where: { id: setupId },
                data,
            });
        });

        if (setupCompleted && applicationId != null) {
            await this.activateSnapshotAfterSetupCompletion(setupId, applicationId, organizationId);
        }

        log.info("Updated application setup", { setupId, ...body });
    }

    /**
     * Activate the pending snapshot a setup just produced. Finish setup (SDK +
     * CLI artifact upload) creates the snapshot the artifact upload produces, so
     * it must be activated now. Both completion paths reach this: the planner's
     * final `step.completed` event and the admin manual upload's
     * `PATCH {status:"completed"}`.
     *
     * Finish setup and onboarding's "Go live" are independent signals and nothing
     * enforces their order, so we can land here before `goLive` was ever clicked.
     * Reaching `diff_trigger` means the preview was verified, which is the only
     * precondition for activating safely - so from there we go live ourselves
     * rather than depend on a manual click the user may never make. Before that
     * the preview is genuinely unverified, so we defer (and warn, so a stuck app
     * is visible). Activation is idempotent, so a double signal is harmless.
     */
    private async activateSnapshotAfterSetupCompletion(
        setupId: string,
        applicationId: string,
        organizationId: string,
    ): Promise<void> {
        const onboardingState = await this.onboardingManager.getState(applicationId);

        if (onboardingState.step === "completed") {
            await this.onboardingManager.activatePendingSnapshot(applicationId, organizationId);
            log.info("Activated pending snapshot after setup completion", { setupId, applicationId });
            return;
        }

        const readyToGoLive = this.onboardingManager.isStepAtOrPast(onboardingState.step, "diff_trigger");
        if (readyToGoLive) {
            log.info("Setup completed and preview verified - going live to activate snapshot", {
                setupId,
                applicationId,
                step: onboardingState.step,
            });
            await this.onboardingManager.goLive(applicationId, organizationId);
            return;
        }

        log.warn("Setup completed but preview not verified yet - deferring snapshot activation to go-live", {
            setupId,
            applicationId,
            step: onboardingState.step,
        });
    }

    async uploadArtifacts(setupId: string, organizationId: string, body: UploadArtifactsBody) {
        const setup = await this.getSetupWithBranch(setupId, organizationId);
        const branchId = setup.application.mainBranch?.id;
        if (branchId == null) throw new Error("Application has no main branch");
        this.assertNoScenarioRecipesInArtifacts(body.artifacts ?? []);

        const updater = await this.getUpdater(branchId, organizationId);
        await this.applyTests(updater, body.testCases ?? [], setup.applicationId, organizationId);
        await this.createFileEvents(setupId, body);
        if (body.commitSha != null) {
            await this.recordCommit(branchId, body.commitSha);
        }

        // applyTests only creates the pending TestGeneration rows, it never runs
        // them - firing through the same gated path `addEvent`/`updateSetup` use
        // (rather than calling `queueGenerations` directly) so artifact upload
        // respects the same "preview must be verified first" precondition. CLI
        // artifact upload can land before the deployment's SDK endpoint is even
        // configured, and firing unconditionally sent every generation straight
        // to a guaranteed "does not have an SDK URL configured" failure.
        await this.activateSnapshotAfterSetupCompletion(setupId, setup.applicationId, organizationId);

        log.info("Uploaded artifacts", {
            setupId,
            testCases: body.testCases?.length ?? 0,
            artifacts: body.artifacts?.length ?? 0,
        });
    }

    /**
     * Stamps the commit the artifacts were generated from onto the pending
     * snapshot the updater just created (head_sha), mirroring how the GitHub
     * diff flow records commits. Once that snapshot activates it becomes the
     * branch's active snapshot, so its head_sha is the branch's handled commit.
     */
    private async recordCommit(branchId: string, commitSha: string) {
        const branch = await this.db.branch.findUnique({
            where: { id: branchId },
            select: { pendingSnapshotId: true },
        });

        if (branch?.pendingSnapshotId == null) {
            log.warn("No pending snapshot to record commit on", { extra: { branchId, commitSha } });
            return;
        }

        await this.db.branchSnapshot.update({
            where: { id: branch.pendingSnapshotId },
            data: { headSha: commitSha },
        });

        log.info("Recorded commit for uploaded artifacts", {
            extra: { branchId, commitSha, pendingSnapshotId: branch.pendingSnapshotId },
        });
    }

    async listScenariosForSetup(setupId: string, organizationId: string) {
        const setup = await this.getSetupWithBranch(setupId, organizationId);
        const scenarios = await this.db.scenario.findMany({
            where: { applicationId: setup.applicationId },
            orderBy: { name: "asc" },
            select: {
                id: true,
                name: true,
                isDisabled: true,
                activeRecipeVersionId: true,
            },
        });
        return {
            scenarios: scenarios.map((s) => ({
                id: s.id,
                name: s.name,
                isDisabled: s.isDisabled,
                hasActiveRecipe: s.activeRecipeVersionId != null,
            })),
        };
    }

    async listScenariosForApplication(applicationId: string, organizationId: string) {
        const application = await this.db.application.findFirst({
            where: { OR: [{ id: applicationId }, { slug: applicationId }], organizationId },
            select: { id: true },
        });
        if (application == null) throw new NotFoundError("Application not found");
        const scenarios = await this.db.scenario.findMany({
            where: { applicationId: application.id },
            orderBy: { name: "asc" },
            select: { id: true, name: true, isDisabled: true, activeRecipeVersionId: true },
        });
        return {
            scenarios: scenarios.map((s) => ({
                id: s.id,
                name: s.name,
                isDisabled: s.isDisabled,
                hasActiveRecipe: s.activeRecipeVersionId != null,
            })),
        };
    }

    async getTestSuiteForApplication(applicationId: string, organizationId: string) {
        const application = await this.db.application.findFirst({
            where: { OR: [{ id: applicationId }, { slug: applicationId }], organizationId },
            select: {
                mainBranch: {
                    select: {
                        pendingSnapshot: { select: { id: true } },
                        activeSnapshot: { select: { id: true } },
                    },
                },
            },
        });
        const branch = application?.mainBranch;
        const snapshotId = branch?.pendingSnapshot?.id ?? branch?.activeSnapshot?.id;
        if (snapshotId == null) return { tests: [] };

        const suiteInfo = await fetchTestSuiteInfo(this.db, snapshotId);
        return {
            tests: suiteInfo.testCases
                .filter((tc) => tc.plan != null)
                .map((tc) => ({ id: tc.id, name: tc.name, slug: tc.slug, prompt: tc.plan!.prompt })),
        };
    }

    async uploadScenarioRecipeVersions(
        setupId: string,
        organizationId: string,
        body: UploadScenarioRecipeVersionsBody,
    ) {
        const setup = await this.getSetupWithBranch(setupId, organizationId);
        const result = await this.ingestScenarioRecipesForSetup(setup, body);

        await this.relateTestPlansToScenarios(setup.applicationId, result.scenarios);

        return {
            ok: true as const,
            scenarioCount: result.scenarioCount,
            scenarios: result.scenarios,
        };
    }

    private async getSetupWithBranch(setupId: string, organizationId: string): Promise<SetupWithBranch> {
        const setup = await this.db.applicationSetup.findFirst({
            where: { id: setupId, organizationId },
            select: {
                id: true,
                applicationId: true,
                application: {
                    select: {
                        mainBranch: {
                            select: {
                                id: true,
                                activeSnapshot: { select: { id: true } },
                                pendingSnapshot: { select: { id: true } },
                            },
                        },
                    },
                },
            },
        });
        if (setup == null) throw new NotFoundError("Application setup not found");
        return setup;
    }

    private async getUpdater(branchId: string, organizationId: string) {
        try {
            return await TestSuiteUpdater.startUpdate({
                db: this.db,
                branchId,
                organizationId,
                jobProvider: this.generationProvider,
            });
        } catch (err) {
            if (!(err instanceof BranchAlreadyHasPendingSnapshotError)) {
                throw err;
            }

            log.info("Pending snapshot exists, continuing update", { branchId });
            return TestSuiteUpdater.continueUpdate({
                db: this.db,
                branchId,
                organizationId,
                jobProvider: this.generationProvider,
            });
        }
    }

    private async applyTests(
        updater: TestSuiteUpdater,
        testCases: NonNullable<UploadArtifactsBody["testCases"]>,
        applicationId: string,
        organizationId: string,
    ): Promise<void> {
        const scenarios = await this.db.scenario.findMany({
            where: { applicationId },
            select: { id: true, name: true, activeRecipeVersionId: true },
        });
        const scenarioByName = new Map(scenarios.map((s) => [s.name, s]));

        const folderCache = new Map<string, string>();

        for (const testCase of testCases) {
            const { data, content: plan } = matter(testCase.content);
            const frontmatter = TestCaseFrontmatterSchema.parse(data);
            const scenarioName = frontmatter.scenario;

            let scenarioId: string | undefined;
            if (scenarioName != null) {
                const scenario = scenarioByName.get(scenarioName);
                if (scenario == null) {
                    log.warn("Test references unknown scenario - scenario recipes must be uploaded before tests", {
                        testCase: testCase.name,
                        scenarioName,
                        applicationId,
                    });
                } else {
                    scenarioId = scenario.id;
                    if (scenario.activeRecipeVersionId == null) {
                        log.warn("Scenario has no active recipe version", {
                            testCase: testCase.name,
                            scenarioName,
                            scenarioId,
                        });
                    }
                }
            }

            const folderName = testCase.folder ?? "default";
            const folderId = await this.findOrCreateFolder(applicationId, organizationId, folderName, folderCache);

            await updater.apply(
                new AddTest({
                    name: testCase.name,
                    description: frontmatter.description,
                    plan: plan.trim(),
                    folderId,
                    scenarioId,
                    scenarioName,
                }),
            );
        }
    }

    private async findOrCreateFolder(
        applicationId: string,
        organizationId: string,
        folderName: string,
        cache: Map<string, string>,
    ): Promise<string> {
        const cached = cache.get(folderName);
        if (cached != null) return cached;

        const folderId = await this.db.$transaction(async (tx) => {
            const existing = await tx.folder.findFirst({
                where: { applicationId, name: folderName, parentId: null },
                select: { id: true },
            });

            if (existing != null) return existing.id;

            const created = await tx.folder.create({
                data: { name: folderName, applicationId, organizationId },
                select: { id: true },
            });
            log.info("Created folder for test case upload", { folderName, folderId: created.id, applicationId });
            return created.id;
        });

        cache.set(folderName, folderId);
        return folderId;
    }

    private async createFileEvents(setupId: string, body: UploadArtifactsBody): Promise<void> {
        const fileEvents: Array<{ type: "file.created"; data: { filePath: string } }> = [
            ...(body.testCases ?? []).map((testCase) => ({
                type: "file.created" as const,
                data: {
                    filePath:
                        testCase.folder != null
                            ? `autonoma/qa-tests/${testCase.folder}/${testCase.name}`
                            : `autonoma/qa-tests/${testCase.name}`,
                },
            })),
            ...(body.artifacts ?? []).map((artifact) => ({
                type: "file.created" as const,
                data: { filePath: buildArtifactPath(artifact) },
            })),
        ];

        if (fileEvents.length === 0) {
            return;
        }

        await this.db.applicationSetupEvent.createMany({
            data: fileEvents.map((event) => ({
                setupId,
                type: event.type,
                data: event.data as Record<string, unknown>,
            })),
        });
    }

    private async ingestScenarioRecipesForSetup(
        setup: SetupWithBranch,
        body: UploadScenarioRecipeVersionsBody,
    ): Promise<{ scenarioCount: number; scenarios: Array<{ id: string; name: string; recipeVersionId: string }> }> {
        const snapshotId = setup.application.mainBranch?.activeSnapshot?.id;
        if (snapshotId == null) {
            throw new BadRequestError("Application main branch has no active snapshot");
        }

        const result = await this.recipeStore.replaceScenarioRecipes({
            snapshotId,
            applicationId: setup.applicationId,
            recipesFile: body,
        });
        log.info("Ingested scenario recipes", {
            setupId: setup.id,
            snapshotId,
            applicationId: setup.applicationId,
            scenarioCount: result.scenarioCount,
        });

        const pendingSnapshotId = setup.application.mainBranch?.pendingSnapshot?.id;
        if (pendingSnapshotId != null && pendingSnapshotId !== snapshotId) {
            log.info("Replicating scenario recipes to pending snapshot", {
                setupId: setup.id,
                activeSnapshotId: snapshotId,
                pendingSnapshotId,
            });
            await this.recipeStore.replaceScenarioRecipes({
                snapshotId: pendingSnapshotId,
                applicationId: setup.applicationId,
                recipesFile: body,
            });

            await this.db.$transaction(
                result.scenarios.map((s) =>
                    this.db.scenario.update({
                        where: { id: s.id },
                        data: { activeRecipeVersionId: s.recipeVersionId },
                    }),
                ),
            );
        }

        return result;
    }

    /**
     * After scenario recipes are ingested, test plans that were uploaded before
     * scenarios existed will have `scenarioId = NULL` but `scenarioName` set.
     * Resolve the deferred reference by matching `scenarioName` against the
     * just-created scenario records.
     */
    private async relateTestPlansToScenarios(applicationId: string, scenarios: Array<{ id: string; name: string }>) {
        if (scenarios.length === 0) return;

        const scenarioIdByName = new Map(scenarios.map((s) => [s.name, s.id]));

        const unlinkedPlans = await this.db.testPlan.findMany({
            where: {
                scenarioId: null,
                scenarioName: { not: null },
                testCase: { applicationId },
            },
            select: { id: true, scenarioName: true },
        });

        if (unlinkedPlans.length === 0) return;

        let linked = 0;
        for (const plan of unlinkedPlans) {
            const scenarioId = scenarioIdByName.get(plan.scenarioName!);
            if (scenarioId == null) continue;

            await this.db.testPlan.update({
                where: { id: plan.id },
                data: { scenarioId },
            });
            linked++;
        }

        if (linked > 0) {
            log.info("Related test plans to scenarios", { applicationId, linked, total: unlinkedPlans.length });
        }
    }

    private assertNoScenarioRecipesInArtifacts(artifacts: NonNullable<UploadArtifactsBody["artifacts"]>) {
        const scenarioRecipeArtifact = artifacts.find(
            (artifact) => buildArtifactPath(artifact) === SCENARIO_RECIPES_ARTIFACT_PATH,
        );
        if (scenarioRecipeArtifact == null) {
            return;
        }
        throw new BadRequestError(
            "SCENARIO_RECIPES_MUST_USE_VERSIONED_ENDPOINT: upload scenario recipes through /scenario-recipe-versions instead of /artifacts",
        );
    }
}
