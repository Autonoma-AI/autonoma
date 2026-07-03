import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import { Service } from "../service";

export class TestsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly storageProvider: StorageProvider,
    ) {
        super();
    }

    async getTestCases(applicationId: string, organizationId: string) {
        this.logger.info("Getting test cases", { applicationId, organizationId });

        const raw = await this.db.testCase.findMany({
            // Exclude investigation shadow cases (validation probes) - they are never part of the customer's suite.
            where: { applicationId, application: { organizationId }, shadow: false },
            include: {
                tags: { include: { tag: true } },
                plans: {
                    include: {
                        stepLists: {
                            include: { _count: { select: { list: true } } },
                        },
                    },
                },
            },
            orderBy: { name: "asc" },
        });

        return raw.map((tc) => {
            let stepCount = 0;
            for (const plan of tc.plans) {
                for (const stepList of plan.stepLists) {
                    stepCount += stepList._count.list;
                }
            }
            return {
                id: tc.id,
                name: tc.name,
                slug: tc.slug,
                description: tc.description ?? undefined,
                folderId: tc.folderId,
                tags: tc.tags.map((tt) => tt.tag.name),
                stepCount,
            };
        });
    }

    async getTestDetail(applicationId: string, slug: string, snapshotId: string, organizationId: string) {
        this.logger.info("Getting test detail", { applicationId, slug, snapshotId });

        const testCase = await this.db.testCase.findUnique({
            // shadow: false - the reserved shadow slug is a known constant, so guard against fetching the probe.
            where: { applicationId_slug: { applicationId, slug }, organizationId, shadow: false },
            include: {
                tags: { include: { tag: true } },
                folder: { select: { id: true, name: true } },
                application: { select: { id: true, name: true } },
            },
        });

        if (testCase == null) throw new NotFoundError("Test case not found");

        const assignment = await this.db.testCaseAssignment.findFirst({
            where: { snapshotId, testCaseId: testCase.id },
            include: {
                plan: {
                    select: {
                        id: true,
                        prompt: true,
                        generations: {
                            where: { snapshotId },
                            select: { id: true },
                            orderBy: { id: "desc" },
                            take: 1,
                        },
                    },
                },
                steps: {
                    include: {
                        list: { orderBy: { order: "asc" } },
                    },
                },
            },
        });

        const steps = assignment?.steps?.list ?? [];

        return {
            id: testCase.id,
            name: testCase.name,
            slug: testCase.slug,
            description: testCase.description ?? undefined,
            applicationId: testCase.application.id,
            folderName: testCase.folder.name,
            tags: testCase.tags.map((tt) => tt.tag.name),
            prompt: assignment?.plan?.prompt ?? undefined,
            generationId: assignment?.plan?.generations[0]?.id ?? undefined,
            steps: await Promise.all(
                steps.map(async (step) => ({
                    id: step.id,
                    order: step.order,
                    interaction: step.interaction,
                    params: step.params,
                    screenshotBefore: await (step.screenshotBefore &&
                        this.storageProvider.getSignedUrl(step.screenshotBefore, 3600)),
                    screenshotAfter: await (step.screenshotAfter &&
                        this.storageProvider.getSignedUrl(step.screenshotAfter, 3600)),
                })),
            ),
            createdAt: testCase.createdAt,
            updatedAt: testCase.updatedAt,
        };
    }

    async renameTest(id: string, name: string, organizationId: string) {
        this.logger.info("Renaming test", { id, name });

        const { count } = await this.db.testCase.updateMany({
            // shadow: false - a user must not rename the shared investigation probe (would break in-flight runs).
            where: { id, application: { organizationId }, shadow: false },
            data: { name },
        });

        if (count === 0) throw new NotFoundError();

        this.logger.info("Test renamed", { id, name });
    }

    async deleteTest(id: string, organizationId: string) {
        this.logger.info("Deleting test", { id });

        // shadow: false - a user must not delete the shared investigation probe (would break in-flight runs).
        const { count } = await this.db.testCase.deleteMany({
            where: { id, application: { organizationId }, shadow: false },
        });

        if (count === 0) throw new NotFoundError();

        this.logger.info("Test deleted", { id });
    }
}
