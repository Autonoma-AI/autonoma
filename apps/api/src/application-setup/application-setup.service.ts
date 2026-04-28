import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { logger } from "@autonoma/logger";
import type { ScenarioManager } from "@autonoma/scenario";
import {
    AddSkill,
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
    TOTAL_SETUP_STEPS,
} from "@autonoma/types";
import { toSlug } from "@autonoma/utils";
import matter from "gray-matter";
import type { OnboardingManager } from "../routes/onboarding/onboarding-manager";
import { InvalidOnboardingStepError } from "../routes/onboarding/states/onboarding-state";

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
        private readonly scenarioManager: ScenarioManager,
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

        await this.advanceOnboardingForAgentConnection(applicationId);

        log.info("Created application setup", { setupId: setup.id, applicationId });
        return { id: setup.id, applicationId };
    }

    private async advanceOnboardingForAgentConnection(applicationId: string) {
        const onboarding = await this.onboardingManager.getState(applicationId);

        if (onboarding.step === "install") {
            await this.onboardingManager.startConfigure(applicationId);
        }

        try {
            await this.onboardingManager.markAgentConnected(applicationId);
        } catch (err) {
            if (err instanceof InvalidOnboardingStepError) {
                const latest = await this.onboardingManager.getState(applicationId);
                if (
                    latest.step === "working" ||
                    latest.step === "webhook_configuring" ||
                    latest.step === "discovering" ||
                    latest.step === "discovered" ||
                    latest.step === "dry_run_passed" ||
                    latest.step === "url" ||
                    latest.step === "github" ||
                    latest.step === "completed"
                ) {
                    log.info("Agent connected - onboarding already at or past working step", {
                        applicationId,
                        step: latest.step,
                    });
                    return;
                }
            }
            throw err;
        }
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

        // Advance onboarding after the transaction commits so there's no deadlock
        if (setupCompleted && applicationId != null) {
            const onboardingState = await this.onboardingManager.getState(applicationId);
            if (onboardingState.step === "completed") {
                await this.onboardingManager.enqueueGenerations(applicationId, organizationId);
                log.info("Queued pending generations after setup completion (onboarding completed)", {
                    setupId,
                    applicationId,
                });
            } else {
                try {
                    await this.onboardingManager.startScenarioDryRun(applicationId);
                    log.info("Advanced onboarding to scenario_dry_run after setup completion", {
                        setupId,
                        applicationId,
                    });
                } catch (err) {
                    if (err instanceof InvalidOnboardingStepError) {
                        log.info("Onboarding already past working step", { applicationId });
                    } else {
                        throw err;
                    }
                }
            }
        }

        log.info("Added setup event", { setupId, type: event.type });
    }

    async updateSetup(setupId: string, organizationId: string, body: UpdateSetupBody) {
        await this.db.$transaction(async (tx) => {
            const setup = await tx.applicationSetup.findUnique({ where: { id: setupId, organizationId } });
            if (setup == null) throw new NotFoundError("Application setup not found");

            const data: Record<string, unknown> = {};
            if (body.name != null) data.name = body.name;
            if (body.status === "completed") {
                data.status = "completed";
                data.completedAt = new Date();
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

        log.info("Updated application setup", { setupId, ...body });
    }

    async uploadArtifacts(setupId: string, organizationId: string, body: UploadArtifactsBody) {
        const setup = await this.getSetupWithBranch(setupId, organizationId);
        const branchId = setup.application.mainBranch?.id;
        if (branchId == null) throw new Error("Application has no main branch");
        this.assertNoScenarioRecipesInArtifacts(body.artifacts ?? []);

        const updater = await this.getUpdater(branchId, organizationId);
        await this.applySkills(updater, body.skills ?? []);
        await this.applyTests(updater, body.testCases ?? [], setup.applicationId, organizationId);
        await this.createFileEvents(setupId, body);

        log.info("Uploaded artifacts", {
            setupId,
            skills: body.skills?.length ?? 0,
            testCases: body.testCases?.length ?? 0,
            artifacts: body.artifacts?.length ?? 0,
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
        if (snapshotId == null) return { tests: [], skills: [] };

        const suiteInfo = await fetchTestSuiteInfo(this.db, snapshotId);
        return {
            tests: suiteInfo.testCases
                .filter((tc) => tc.plan != null)
                .map((tc) => ({ id: tc.id, name: tc.name, slug: tc.slug, prompt: tc.plan!.prompt })),
            skills: suiteInfo.skills
                .filter((s) => s.plan != null)
                .map((s) => ({
                    id: s.id,
                    name: s.name,
                    slug: s.slug,
                    description: s.description,
                    content: s.plan!.content,
                })),
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

    private async applySkills(
        updater: TestSuiteUpdater,
        skills: NonNullable<UploadArtifactsBody["skills"]>,
    ): Promise<void> {
        for (const skill of skills) {
            const { data: frontmatter, content } = matter(skill.content);
            const name = (frontmatter.name as string | undefined) ?? skill.name.replace(/\.(md|markdown)$/i, "");
            const description = (frontmatter.description as string | undefined) ?? name;
            await updater.apply(new AddSkill({ name, description, plan: content.trim() }));
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
            const { data: frontmatter, content: plan } = matter(testCase.content);
            const scenarioName = frontmatter.scenario as string | undefined;

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
                new AddTest({ name: testCase.name, plan: plan.trim(), folderId, scenarioId, scenarioName }),
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
            ...(body.skills ?? []).map((skill) => ({
                type: "file.created" as const,
                data: { filePath: `autonoma/skills/${skill.name}` },
            })),
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

        const result = await this.scenarioManager.ingestScenarioRecipes(snapshotId, setup.applicationId, body);
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
            await this.scenarioManager.ingestScenarioRecipes(pendingSnapshotId, setup.applicationId, body);

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
