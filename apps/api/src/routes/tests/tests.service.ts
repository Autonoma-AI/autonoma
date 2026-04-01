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
            where: { applicationId, application: { organizationId } },
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
            where: { applicationId_slug: { applicationId, slug }, organizationId },
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
            folderName: testCase.folder?.name ?? undefined,
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

    async updateTestDescription(id: string, description: string, organizationId: string) {
        this.logger.info("Updating test description", { id });

        const { count } = await this.db.testCase.updateMany({
            where: { id, application: { organizationId } },
            data: { description },
        });

        if (count === 0) throw new NotFoundError();

        this.logger.info("Test description updated", { id });
    }

    async renameTest(id: string, name: string, organizationId: string) {
        this.logger.info("Renaming test", { id, name });

        const { count } = await this.db.testCase.updateMany({
            where: { id, application: { organizationId } },
            data: { name },
        });

        if (count === 0) throw new NotFoundError();

        this.logger.info("Test renamed", { id, name });
    }

    async deleteTest(id: string, organizationId: string) {
        this.logger.info("Deleting test", { id });

        const { count } = await this.db.testCase.deleteMany({ where: { id, application: { organizationId } } });

        if (count === 0) throw new NotFoundError();

        this.logger.info("Test deleted", { id });
    }
}
