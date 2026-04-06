import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger } from "@autonoma/logger";
import {
    AddSkill,
    AddTest,
    BranchAlreadyHasPendingSnapshotError,
    type GenerationProvider,
    TestSuiteUpdater,
} from "@autonoma/test-updates";
import type { SetupEventBody, UpdateSetupBody, UploadArtifactsBody } from "@autonoma/types";
import { TOTAL_SETUP_STEPS } from "@autonoma/types";
import { toSlug } from "@autonoma/utils";
import matter from "gray-matter";
import type { OnboardingManager } from "../routes/onboarding/onboarding-manager";
import { InvalidOnboardingStepError } from "../routes/onboarding/states/onboarding-state";

const log = logger.child({ name: "ApplicationSetupService" });

export class ApplicationSetupService {
    constructor(
        private readonly db: PrismaClient,
        private readonly generationProvider: GenerationProvider,
        private readonly onboardingManager: OnboardingManager,
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

            return await tx.applicationSetup.create({
                data: {
                    applicationId,
                    organizationId,
                    userId,
                    totalSteps: TOTAL_SETUP_STEPS,
                },
            });
        });

        try {
            await this.onboardingManager.markAgentConnected(applicationId);
        } catch (err) {
            if (err instanceof InvalidOnboardingStepError) {
                log.info("Agent reconnected - onboarding already past configure step", { applicationId });
            } else {
                throw err;
            }
        }

        log.info("Created application setup", { setupId: setup.id, applicationId });
        return { id: setup.id };
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
        await this.db.$transaction(async (tx) => {
            const setup = await tx.applicationSetup.findUnique({ where: { id: setupId, organizationId } });
            if (setup == null) throw new NotFoundError("Application setup not found");

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
            }

            if (event.type === "error") {
                await tx.applicationSetup.update({
                    where: { id: setupId },
                    data: { status: "failed", errorMessage: event.data.message },
                });
            }
        });

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
            if (body.status === "failed") {
                data.status = "failed";
                data.errorMessage = body.errorMessage;
            }

            await tx.applicationSetup.update({
                where: { id: setupId },
                data,
            });
        });

        log.info("Updated application setup", { setupId, ...body });
    }

    async uploadArtifacts(setupId: string, organizationId: string, body: UploadArtifactsBody) {
        const setup = await this.db.applicationSetup.findFirst({
            where: { id: setupId, organizationId },
            select: {
                application: {
                    select: { mainBranch: { select: { id: true } } },
                },
            },
        });
        if (setup == null) throw new NotFoundError("Application setup not found");

        const branchId = setup.application.mainBranch?.id;
        if (branchId == null) throw new Error("Application has no main branch");

        let updater: TestSuiteUpdater;
        try {
            updater = await TestSuiteUpdater.startUpdate({
                db: this.db,
                branchId,
                organizationId,
                jobProvider: this.generationProvider,
            });
        } catch (err) {
            if (err instanceof BranchAlreadyHasPendingSnapshotError) {
                log.info("Pending snapshot exists, continuing update", { branchId });
                updater = await TestSuiteUpdater.continueUpdate({
                    db: this.db,
                    branchId,
                    organizationId,
                    jobProvider: this.generationProvider,
                });
            } else {
                throw err;
            }
        }

        for (const skill of body.skills ?? []) {
            const { data: frontmatter, content } = matter(skill.content);
            const name = (frontmatter.name as string | undefined) ?? skill.name.replace(/\.(md|markdown)$/i, "");
            const description = (frontmatter.description as string | undefined) ?? name;
            await updater.apply(new AddSkill({ name, description, plan: content.trim() }));
        }

        for (const tc of body.testCases ?? []) {
            const { content: plan } = matter(tc.content);
            await updater.apply(new AddTest({ name: tc.name, plan: plan.trim() }));
        }

        const fileEvents: Array<{ type: "file.created"; data: { filePath: string } }> = [
            ...(body.skills ?? []).map((s) => ({
                type: "file.created" as const,
                data: { filePath: `autonoma/skills/${s.name}` },
            })),
            ...(body.testCases ?? []).map((tc) => ({
                type: "file.created" as const,
                data: {
                    filePath:
                        tc.folder != null
                            ? `autonoma/qa-tests/${tc.folder}/${tc.name}`
                            : `autonoma/qa-tests/${tc.name}`,
                },
            })),
        ];

        if (fileEvents.length > 0) {
            await this.db.applicationSetupEvent.createMany({
                data: fileEvents.map((e) => ({
                    setupId,
                    type: e.type,
                    data: e.data as Record<string, unknown>,
                })),
            });
        }

        log.info("Uploaded artifacts", {
            setupId,
            skills: body.skills?.length ?? 0,
            testCases: body.testCases?.length ?? 0,
        });
    }
}
