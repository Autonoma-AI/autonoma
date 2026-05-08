import type { GenerationStatus, PrismaClient } from "@autonoma/db";
import { BadRequestError, InternalError, NotFoundError } from "@autonoma/errors";
import {
    getChangesForSnapshot,
    summarizeChangesForSnapshot,
    fetchTestSuiteInfo,
    type SnapshotChangeSummary,
} from "@autonoma/test-updates";
import { Service } from "../service";

export class BranchesService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async listBranches(applicationId: string, organizationId: string) {
        this.logger.info("Listing branches", { applicationId });

        const branches = await this.db.branch.findMany({
            where: { applicationId, prInfo: { isNot: null }, application: { organizationId } },
            select: {
                id: true,
                name: true,
                createdAt: true,
                prInfo: { select: { prNumber: true } },
                activeSnapshot: {
                    select: {
                        id: true,
                        status: true,
                        _count: { select: { testCaseAssignments: true } },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        return branches.map(({ prInfo, ...branch }) => ({
            ...branch,
            prNumber: prInfo!.prNumber,
        }));
    }

    async getBranch(branchId: string, organizationId: string) {
        this.logger.info("Getting branch", { branchId });

        const branch = await this.db.branch.findFirst({
            where: { id: branchId, application: { organizationId } },
            include: {
                activeSnapshot: {
                    include: {
                        testCaseAssignments: {
                            include: {
                                testCase: { select: { id: true, name: true, slug: true, folderId: true } },
                                plan: { select: { id: true, prompt: true } },
                                steps: {
                                    select: {
                                        id: true,
                                        _count: { select: { list: true } },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (branch == null) throw new NotFoundError("Branch not found");
        return branch;
    }

    async getBranchByName(applicationId: string, branchName: string, organizationId: string) {
        this.logger.info("Getting branch by name", { applicationId, branchName });

        const branch = await this.db.branch.findFirst({
            where: {
                applicationId,
                name: branchName,
                application: { organizationId },
            },
            select: {
                id: true,
                name: true,
                pendingSnapshotId: true,
                createdAt: true,
                updatedAt: true,
                activeSnapshot: {
                    select: {
                        id: true,
                        status: true,
                        createdAt: true,
                        source: true,
                        testCaseAssignments: {
                            select: {
                                id: true,
                                testCaseId: true,
                                testCase: { select: { id: true, name: true, slug: true, folderId: true } },
                                plan: { select: { id: true } },
                                stepsId: true,
                            },
                        },
                    },
                },
            },
        });

        if (branch == null) throw new NotFoundError("Branch not found");
        if (branch.activeSnapshot == null) throw new InternalError("Branch has no active snapshot");

        return { ...branch, activeSnapshot: branch.activeSnapshot };
    }

    async listSnapshots(branchId: string, organizationId: string) {
        this.logger.info("Listing snapshots", { branchId });

        const snapshots = await this.db.branchSnapshot.findMany({
            where: { branchId, branch: { application: { organizationId } } },
            select: {
                id: true,
                status: true,
                source: true,
                headSha: true,
                baseSha: true,
                createdAt: true,
                prevSnapshotId: true,
                _count: { select: { testCaseAssignments: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        const changeSummaries = await Promise.all(
            snapshots.map((s) => summarizeChangesForSnapshot(this.db, s.id, s.prevSnapshotId, this.logger)),
        );

        return snapshots.map((snapshot, index) => ({
            ...snapshot,
            changeSummary: changeSummaries[index] as SnapshotChangeSummary,
        }));
    }

    async getBranchByPr(applicationId: string, prNumber: number, organizationId: string) {
        this.logger.info("Getting branch by PR", { applicationId, prNumber });

        const branch = await this.db.branch.findFirst({
            where: {
                applicationId,
                prInfo: { prNumber },
                application: { organizationId },
            },
            select: {
                id: true,
                name: true,
                createdAt: true,
                updatedAt: true,
                prInfo: { select: { prNumber: true } },
            },
        });

        if (branch == null) throw new NotFoundError("Pull request not found");
        if (branch.prInfo == null) throw new InternalError("Branch has no PR info");

        const { prInfo, ...rest } = branch;
        return { ...rest, prNumber: prInfo.prNumber };
    }

    async getSnapshotDetail(snapshotId: string, organizationId: string) {
        this.logger.info("Getting snapshot detail", { snapshotId });

        const snapshot = await this.db.branchSnapshot.findUnique({
            where: { id: snapshotId, branch: { organizationId } },
            select: {
                id: true,
                status: true,
                source: true,
                headSha: true,
                baseSha: true,
                createdAt: true,
                prevSnapshotId: true,
                branch: {
                    select: {
                        id: true,
                        name: true,
                        applicationId: true,
                        prInfo: { select: { prNumber: true } },
                    },
                },
                diffsJob: {
                    select: {
                        status: true,
                        analysisReasoning: true,
                        resolutionReasoning: true,
                        failureReason: true,
                        startedAt: true,
                        completedAt: true,
                        affectedTests: {
                            select: {
                                affectedReason: true,
                                reasoning: true,
                                testCase: { select: { id: true, name: true, slug: true } },
                                run: {
                                    select: {
                                        id: true,
                                        status: true,
                                        runReview: { select: { verdict: true } },
                                    },
                                },
                                generation: { select: { id: true, status: true } },
                            },
                            orderBy: { createdAt: "asc" },
                        },
                        testCandidates: {
                            select: {
                                id: true,
                                name: true,
                                instruction: true,
                                reasoning: true,
                                status: true,
                                acceptedTestCase: { select: { id: true, name: true, slug: true } },
                            },
                            orderBy: { createdAt: "asc" },
                        },
                    },
                },
            },
        });

        if (snapshot == null) throw new NotFoundError("Snapshot not found");
        if (snapshot.diffsJob == null) throw new NotFoundError("Snapshot has no diffs job");

        const { prInfo, ...branchRest } = snapshot.branch;
        const { diffsJob, branch: _branch, ...snapshotRest } = snapshot;
        const flatSnapshot = {
            ...snapshotRest,
            branch: { ...branchRest, prNumber: prInfo?.prNumber },
        };

        const changes = await getChangesForSnapshot(this.db, snapshotId, snapshot.prevSnapshotId, this.logger);

        const acceptedTestCaseIds = diffsJob.testCandidates
            .map((c) => c.acceptedTestCase?.id)
            .filter((id): id is string => id != null);

        const candidateGenByTestCaseId = new Map<string, { id: string; status: GenerationStatus }>();
        if (acceptedTestCaseIds.length > 0) {
            const candidateGens = await this.db.testGeneration.findMany({
                where: { snapshotId, testPlan: { testCaseId: { in: acceptedTestCaseIds } } },
                select: { id: true, status: true, testPlan: { select: { testCaseId: true } } },
                orderBy: { createdAt: "desc" },
            });
            for (const gen of candidateGens) {
                const tcId = gen.testPlan.testCaseId;
                if (!candidateGenByTestCaseId.has(tcId)) {
                    candidateGenByTestCaseId.set(tcId, { id: gen.id, status: gen.status });
                }
            }
        }

        const diffsJobWithCandidateGens = {
            ...diffsJob,
            testCandidates: diffsJob.testCandidates.map((c) => ({
                ...c,
                generation:
                    c.acceptedTestCase != null ? (candidateGenByTestCaseId.get(c.acceptedTestCase.id) ?? null) : null,
            })),
        };

        return { snapshot: flatSnapshot, changes, diffsJob: diffsJobWithCandidateGens };
    }

    async getActiveSnapshot(branchId: string, organizationId: string) {
        this.logger.info("Getting active snapshot", { branchId });

        const branch = await this.db.branch.findUnique({
            where: { id: branchId, organizationId },
            select: {
                id: true,
                name: true,
                activeSnapshotId: true,
                baseSnapshotId: true,
                activeSnapshot: { select: { prevSnapshotId: true } },
                prInfo: { select: { prNumber: true } },
            },
        });

        if (branch == null) throw new NotFoundError("Branch not found");
        if (branch.activeSnapshotId == null) throw new NotFoundError("Branch has no active snapshot");

        let comparisonSnapshotId = branch.baseSnapshotId;
        if (comparisonSnapshotId == null) {
            this.logger.warn("Branch has no baseSnapshotId, falling back to activeSnapshot.prevSnapshotId", {
                branchId,
                activeSnapshotId: branch.activeSnapshotId,
            });
            comparisonSnapshotId = branch.activeSnapshot?.prevSnapshotId ?? null;
        }

        const testSuite = await fetchTestSuiteInfo(this.db, branch.activeSnapshotId);
        const changes = await getChangesForSnapshot(
            this.db,
            branch.activeSnapshotId,
            comparisonSnapshotId,
            this.logger,
        );

        return {
            snapshotId: branch.activeSnapshotId,
            testSuite,
            changes,
            branch: { id: branch.id, name: branch.name, prNumber: branch.prInfo?.prNumber },
        };
    }

    async deleteBranch(branchId: string, organizationId: string) {
        this.logger.info("Deleting branch", { branchId });

        const branch = await this.db.branch.findFirst({
            where: { id: branchId, application: { organizationId } },
            select: {
                id: true,
                application: { select: { mainBranchId: true } },
            },
        });

        if (branch == null) throw new NotFoundError("Branch not found");

        const isMainBranch = branch.application.mainBranchId === branchId;
        if (isMainBranch) {
            throw new BadRequestError("Cannot delete the main branch");
        }

        await this.db.branch.delete({ where: { id: branchId } });

        this.logger.info("Branch deleted", { branchId });
    }
}
