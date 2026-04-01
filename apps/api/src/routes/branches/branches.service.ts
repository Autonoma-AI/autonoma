import type { PrismaClient } from "@autonoma/db";
import { SnapshotStatus, TriggerSource } from "@autonoma/db";
import { BadRequestError, InternalError, NotFoundError } from "@autonoma/errors";
import { Service } from "../service";

export class BranchesService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async listBranches(applicationId: string, organizationId: string) {
        this.logger.info("Listing branches", { applicationId });

        return this.db.branch.findMany({
            where: { applicationId, application: { organizationId } },
            select: {
                id: true,
                name: true,
                githubRef: true,
                createdAt: true,
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
                githubRef: true,
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

        return this.db.branchSnapshot.findMany({
            where: { branchId, branch: { application: { organizationId } } },
            select: {
                id: true,
                status: true,
                source: true,
                createdAt: true,
                _count: { select: { testCaseAssignments: true } },
            },
            orderBy: { createdAt: "desc" },
        });
    }

    async createBranch(applicationId: string, name: string, organizationId: string, githubRef?: string) {
        this.logger.info("Creating branch", { applicationId, name });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                id: true,
                mainBranch: {
                    select: {
                        deploymentId: true,
                        activeSnapshot: {
                            select: {
                                testCaseAssignments: {
                                    select: {
                                        testCaseId: true,
                                        planId: true,
                                        stepsId: true,
                                        id: true,
                                    },
                                },
                                skillAssignments: {
                                    select: {
                                        skillId: true,
                                        planId: true,
                                        id: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (application == null) throw new NotFoundError("Application not found");

        const mainBranch = application.mainBranch;
        const mainTestCaseAssignments = mainBranch?.activeSnapshot?.testCaseAssignments ?? [];
        const mainSkillAssignments = mainBranch?.activeSnapshot?.skillAssignments ?? [];

        return this.db.$transaction(async (tx) => {
            const branch = await tx.branch.create({
                data: {
                    name,
                    applicationId,
                    organizationId,
                    githubRef,
                },
                select: { id: true },
            });

            const snapshot = await tx.branchSnapshot.create({
                data: {
                    branchId: branch.id,
                    source: TriggerSource.MANUAL,
                    status: SnapshotStatus.active,
                    deploymentId: mainBranch?.deploymentId,
                },
                select: { id: true },
            });

            if (mainTestCaseAssignments.length > 0) {
                await tx.testCaseAssignment.createMany({
                    data: mainTestCaseAssignments.map((a) => ({
                        snapshotId: snapshot.id,
                        testCaseId: a.testCaseId,
                        planId: a.planId,
                        stepsId: a.stepsId,
                        mainAssignmentId: a.id,
                    })),
                });
            }

            if (mainSkillAssignments.length > 0) {
                await tx.skillAssignment.createMany({
                    data: mainSkillAssignments.map((a) => ({
                        snapshotId: snapshot.id,
                        skillId: a.skillId,
                        planId: a.planId,
                        mainAssignmentId: a.id,
                    })),
                });
            }

            await tx.branch.update({
                where: { id: branch.id },
                data: { activeSnapshotId: snapshot.id },
            });

            this.logger.info("Branch created", { branchId: branch.id, snapshotId: snapshot.id });

            return { id: branch.id, name };
        });
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
