import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { Service } from "../service";

interface DeleteTestParams {
    testCaseId: string;
    branchId: string;
    organizationId: string;
}

export class TestsService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async getTestCases(applicationId: string, organizationId: string) {
        this.logger.info("Getting test cases", { applicationId, organizationId });

        const raw = await this.db.testCase.findMany({
            where: { applicationId, application: { organizationId } },
            include: {
                tags: { include: { tag: true } },
            },
            orderBy: { name: "asc" },
        });

        return raw.map((tc) => ({
            id: tc.id,
            name: tc.name,
            slug: tc.slug,
            description: tc.description ?? undefined,
            folderId: tc.folderId,
            tags: tc.tags.map((tt) => tt.tag.name),
        }));
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
            },
        });

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
            createdAt: testCase.createdAt,
            updatedAt: testCase.updatedAt,
        };
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

    /**
     * Removes a test from a branch's suite by dropping its assignment from the branch's active snapshot.
     *
     * The `TestCase` row itself is never destroyed. It is an identity record that findings, terminal snapshots'
     * assignments and an issue's covered set all key on, so destroying it would cascade that history away and
     * strand any issue it covered.
     *
     * Only the active snapshot is touched, so a pending snapshot - an open edit session, or an analysis run that
     * forked the suite before this call - still carries the test and reinstates it when it promotes.
     */
    async deleteTest({ testCaseId, branchId, organizationId }: DeleteTestParams) {
        this.logger.info("Deleting test from branch suite", { testCaseId, branchId });

        const { count } = await this.db.testCaseAssignment.deleteMany({
            where: { testCaseId, snapshot: { activeOnBranch: { id: branchId, organizationId } } },
        });

        if (count === 0) throw new NotFoundError("Test not found on this branch");

        this.logger.info("Test deleted from branch suite", { testCaseId, branchId });
    }
}
