import type { GenerationStatus, PrismaClient, RunReviewVerdict, RunStatus } from "@autonoma/db";
import { BadRequestError, InternalError, NotFoundError } from "@autonoma/errors";
import {
    getChangesForSnapshot,
    summarizeChangesForSnapshot,
    fetchTestSuiteInfo,
    type SnapshotChangeSummary,
} from "@autonoma/test-updates";
import { findLatestWorkflowBySnapshotId, type WorkflowRef } from "@autonoma/workflow";
import { Service } from "../service";
import { loadPreviouslyQuarantinedTestCaseIds } from "./quarantine-history";
import { loadRefinementLoop } from "./refinement-loop";
import { listExecutedTestsForSnapshot } from "./snapshot-executed-tests";
import { aggregateSnapshotHealth, computeSnapshotHealth } from "./snapshot-health";
import { computeTestSuiteChanges, emptyTestSuiteChanges } from "./test-suite-changes";

export type { TestSuiteChangeRow } from "./test-suite-changes";

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

        const activeSnapshots = branches
            .map((b) => b.activeSnapshot)
            .filter((s): s is NonNullable<typeof s> => s != null)
            .map((s) => ({ id: s.id, status: s.status }));

        const healthBySnapshot = await aggregateSnapshotHealth(this.db, activeSnapshots, this.logger);

        return branches.map(({ prInfo, activeSnapshot, ...branch }) => ({
            ...branch,
            prNumber: prInfo!.prNumber,
            activeSnapshot:
                activeSnapshot != null
                    ? {
                          id: activeSnapshot.id,
                          status: activeSnapshot.status,
                          _count: { testCaseAssignments: activeSnapshot._count.testCaseAssignments },
                          health: healthBySnapshot.get(activeSnapshot.id)?.health ?? "unknown",
                      }
                    : null,
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
                                        runReview: { select: { verdict: true, reasoning: true } },
                                    },
                                },
                                generation: {
                                    select: {
                                        id: true,
                                        status: true,
                                        generationReview: { select: { reasoning: true } },
                                    },
                                },
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
                testCaseAssignments: {
                    where: { quarantineIssueId: { not: null } },
                    select: {
                        testCaseId: true,
                        testCase: { select: { id: true, name: true, slug: true } },
                        quarantineIssue: { select: { id: true, kind: true, bugId: true } },
                    },
                },
            },
        });

        if (snapshot == null) throw new NotFoundError("Snapshot not found");
        if (snapshot.diffsJob == null) throw new NotFoundError("Snapshot has no diffs job");

        const temporalWorkflowPromise: Promise<WorkflowRef | undefined> = findLatestWorkflowBySnapshotId(
            snapshotId,
        ).catch((error) => {
            this.logger.warn("Could not resolve Temporal workflow for snapshot", { snapshotId, error });
            return undefined;
        });

        const { prInfo, ...branchRest } = snapshot.branch;
        const { diffsJob, branch: _branch, testCaseAssignments, ...snapshotRest } = snapshot;
        const flatSnapshot = {
            ...snapshotRest,
            branch: { ...branchRest, prNumber: prInfo?.prNumber },
        };

        const previouslyQuarantinedTestCaseIds = await loadPreviouslyQuarantinedTestCaseIds(
            this.db,
            snapshot.prevSnapshotId,
        );

        const quarantinedTests = testCaseAssignments
            .filter(
                (
                    a,
                ): a is typeof a & {
                    quarantineIssue: NonNullable<typeof a.quarantineIssue>;
                } => a.quarantineIssue != null && !previouslyQuarantinedTestCaseIds.has(a.testCaseId),
            )
            .map((a) => ({
                testCase: a.testCase,
                reason: a.quarantineIssue.kind,
                issueId: a.quarantineIssue.id,
                bugId: a.quarantineIssue.bugId ?? undefined,
            }));

        const [changes, temporalWorkflow, refinementLoop] = await Promise.all([
            getChangesForSnapshot(this.db, snapshotId, snapshot.prevSnapshotId, this.logger),
            temporalWorkflowPromise,
            loadRefinementLoop(this.db, snapshotId, this.logger),
        ]);

        const acceptedTestCaseIds = diffsJob.testCandidates
            .map((c) => c.acceptedTestCase?.id)
            .filter((id): id is string => id != null);

        const candidateGenByTestCaseId = new Map<
            string,
            { id: string; status: GenerationStatus; reviewReasoning?: string }
        >();
        if (acceptedTestCaseIds.length > 0) {
            const candidateGens = await this.db.testGeneration.findMany({
                where: { snapshotId, testPlan: { testCaseId: { in: acceptedTestCaseIds } } },
                select: {
                    id: true,
                    status: true,
                    testPlan: { select: { testCaseId: true } },
                    generationReview: { select: { reasoning: true } },
                },
                orderBy: { createdAt: "desc" },
            });
            for (const gen of candidateGens) {
                const tcId = gen.testPlan.testCaseId;
                if (!candidateGenByTestCaseId.has(tcId)) {
                    candidateGenByTestCaseId.set(tcId, {
                        id: gen.id,
                        status: gen.status,
                        reviewReasoning: gen.generationReview?.reasoning ?? undefined,
                    });
                }
            }
        }

        const candidateRunByTestCaseId = new Map<
            string,
            {
                id: string;
                status: RunStatus;
                verdict?: RunReviewVerdict;
                reviewReasoning?: string;
            }
        >();
        if (acceptedTestCaseIds.length > 0) {
            const candidateRuns = await this.db.run.findMany({
                where: { assignment: { snapshotId, testCaseId: { in: acceptedTestCaseIds } } },
                select: {
                    id: true,
                    status: true,
                    assignment: { select: { testCaseId: true } },
                    runReview: { select: { verdict: true, reasoning: true } },
                },
                orderBy: { createdAt: "desc" },
            });
            for (const run of candidateRuns) {
                const tcId = run.assignment.testCaseId;
                if (!candidateRunByTestCaseId.has(tcId)) {
                    candidateRunByTestCaseId.set(tcId, {
                        id: run.id,
                        status: run.status,
                        verdict: run.runReview?.verdict ?? undefined,
                        reviewReasoning: run.runReview?.reasoning ?? undefined,
                    });
                }
            }
        }

        const diffsJobWithCandidateGens = {
            ...diffsJob,
            temporalWorkflow,
            testCandidates: diffsJob.testCandidates.map((c) => ({
                ...c,
                generation:
                    c.acceptedTestCase != null ? (candidateGenByTestCaseId.get(c.acceptedTestCase.id) ?? null) : null,
                run: c.acceptedTestCase != null ? (candidateRunByTestCaseId.get(c.acceptedTestCase.id) ?? null) : null,
            })),
        };

        const [healthMap, executedTests] = await Promise.all([
            aggregateSnapshotHealth(this.db, [{ id: snapshot.id, status: snapshot.status }], this.logger),
            listExecutedTestsForSnapshot(this.db, snapshotId),
        ]);
        const healthEntry = healthMap.get(snapshot.id);
        const counts = healthEntry?.counts ?? {
            failing: 0,
            passing: 0,
            running: 0,
            quarantined: 0,
            notAffected: 0,
            totalTests: 0,
        };
        const health = healthEntry?.health ?? computeSnapshotHealth(snapshot.status, counts);

        return {
            snapshot: flatSnapshot,
            changes,
            diffsJob: diffsJobWithCandidateGens,
            quarantinedTests,
            refinementLoop,
            health,
            healthCounts: counts,
            executedTests,
        };
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

    async getTestSuiteChangesByPr(branchId: string, organizationId: string) {
        this.logger.info("Getting PR-wide test suite changes", { branchId });

        const snapshotSelect = {
            id: true,
            headSha: true,
            createdAt: true,
            prevSnapshotId: true,
            testCaseAssignments: {
                select: {
                    testCaseId: true,
                    planId: true,
                    quarantineIssueId: true,
                    testCase: { select: { id: true, name: true, slug: true } },
                },
            },
        } as const;

        const branch = await this.db.branch.findUnique({
            where: { id: branchId, organizationId },
            select: {
                id: true,
                activeSnapshotId: true,
                snapshots: {
                    select: snapshotSelect,
                    orderBy: { createdAt: "asc" },
                },
            },
        });

        if (branch == null) throw new NotFoundError("Branch not found");

        const emptyResult = emptyTestSuiteChanges();

        const prSnapshots = branch.snapshots;
        if (prSnapshots.length === 0) {
            this.logger.warn("Branch has no snapshots", { branchId });
            return emptyResult;
        }

        // Pick the latest PR snapshot as the rollup target. Don't depend on branch.activeSnapshotId
        // being in sync - the rollup should reflect what the user sees as the latest snapshot.
        const activeSnap = prSnapshots[prSnapshots.length - 1]!;

        // The baseline is the earliest PR snapshot's prevSnapshotId (the divergence point on main).
        const baseSnapshotId = prSnapshots[0]?.prevSnapshotId ?? null;
        if (baseSnapshotId == null) {
            this.logger.warn("Earliest PR snapshot has no prevSnapshotId", {
                branchId,
                earliestSnapshotId: prSnapshots[0]?.id,
            });
            return emptyResult;
        }

        const baseSnap = await this.db.branchSnapshot.findUnique({
            where: { id: baseSnapshotId },
            select: snapshotSelect,
        });
        if (baseSnap == null) {
            this.logger.warn("Base snapshot not found", { branchId, baseSnapshotId });
            return emptyResult;
        }

        this.logger.info("Computing PR-wide changes", {
            branchId,
            prSnapshotCount: prSnapshots.length,
            activeSnapshotId: activeSnap.id,
            baseSnapshotId,
            baseAssignmentCount: baseSnap.testCaseAssignments.length,
            activeAssignmentCount: activeSnap.testCaseAssignments.length,
        });

        const changes = computeTestSuiteChanges({ prSnapshots, baseSnap, activeSnap });

        this.logger.info("PR-wide test suite changes computed", {
            branchId,
            added: changes.added.length,
            modified: changes.modified.length,
            removed: changes.removed.length,
            newlyQuarantined: changes.newlyQuarantined.length,
        });

        return changes;
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
