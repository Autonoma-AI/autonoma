import type { Prisma } from "@autonoma/db";
import { type GenerationStatus, type PrismaClient, type RunReviewVerdict, type RunStatus } from "@autonoma/db";
import { BadRequestError, InternalError, NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import {
    getChangesForSnapshot,
    summarizeChangesForSnapshot,
    fetchTestSuiteInfo,
    type SnapshotChangeSummary,
} from "@autonoma/test-updates";
import type { SnapshotReport } from "@autonoma/types";
import { findLatestWorkflowBySnapshotId, type WorkflowRef } from "@autonoma/workflow";
import { z } from "zod";
import type { GitHubInstallationService } from "../../github/github-installation.service";
import type { PullRequestCacheService } from "../../github/pull-request-cache.service";
import { Service } from "../service";
import { signTestSuiteScreenshots } from "../sign-test-suite-screenshots";
import { loadFirstIterationReasoning } from "./first-iteration-reasoning";
import { loadPreviouslyQuarantinedTestCaseIds } from "./quarantine-history";
import { loadRefinementLoop } from "./refinement-loop";
import { listExecutedTestsForSnapshot, type SnapshotExecutedTest } from "./snapshot-executed-tests";
import {
    aggregateSnapshotHealth,
    computeSnapshotHealth,
    tallyExecutedTests,
    type SnapshotHealthCounts,
} from "./snapshot-health";
import { loadSnapshotReport } from "./snapshot-report";
import { computeTestSuiteChanges, emptyTestSuiteChanges } from "./test-suite-changes";

export type { TestSuiteChangeRow } from "./test-suite-changes";

export class BranchesService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly github: GitHubInstallationService,
        private readonly storageProvider: StorageProvider,
        private readonly prCache: PullRequestCacheService,
    ) {
        super();
    }

    async listBranches(applicationId: string, organizationId: string, state: PullRequestStateFilter = "open") {
        this.logger.info("Listing branches", { applicationId, extra: { state } });

        const branches = await this.db.branch.findMany({
            where: { applicationId, prInfo: prInfoStateFilter(state), application: { organizationId } },
            select: {
                id: true,
                name: true,
                createdAt: true,
                prInfo: {
                    select: {
                        prNumber: true,
                        prTitle: true,
                        prState: true,
                        prAuthorLogin: true,
                        prUpdatedAt: true,
                    },
                },
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

        const [healthBySnapshot, bugCountBySnapshot, previewUrlByPr] = await Promise.all([
            aggregateSnapshotHealth(this.db, activeSnapshots, this.logger),
            this.countOpenBugsBySnapshot(activeSnapshots.map((s) => s.id)),
            this.loadPreviewUrlsByPr(
                applicationId,
                organizationId,
                branches.map((b) => ({ branchId: b.id, prNumber: b.prInfo!.prNumber })),
            ),
        ]);

        // Best-effort, fire-and-forget refresh of the cached PR metadata. Throttled in
        // Postgres, so this no-ops when the cache is fresh and never blocks the response.
        this.prCache.kickOff(applicationId, organizationId);

        return branches.map(({ prInfo, activeSnapshot, ...branch }) => ({
            ...branch,
            prNumber: prInfo!.prNumber,
            pr: {
                title: prInfo!.prTitle ?? undefined,
                state: prInfo!.prState ?? undefined,
                authorLogin: prInfo!.prAuthorLogin ?? undefined,
                updatedAt: prInfo!.prUpdatedAt ?? undefined,
            },
            bugCount: activeSnapshot != null ? (bugCountBySnapshot.get(activeSnapshot.id) ?? 0) : 0,
            previewUrl: previewUrlByPr.get(prInfo!.prNumber),
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

    /**
     * Bulk-resolves a preview URL per PR number for an application, so the Home PR
     * list can show a clickable preview link without an N+1 fanout. Mirrors the
     * per-PR preview summary: prefer a Previewkit environment URL (any status with a
     * URL except failed / torn_down), then fall back to the legacy branch webDeployment
     * URL. Returns a map of prNumber -> URL.
     */
    private async loadPreviewUrlsByPr(
        applicationId: string,
        organizationId: string,
        branches: Array<{ branchId: string; prNumber: number }>,
    ): Promise<Map<number, string>> {
        if (branches.length === 0) return new Map();

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        const githubRepositoryId = application?.githubRepositoryId;

        const [previewkitEnvironments, legacyDeployments] = await Promise.all([
            githubRepositoryId != null
                ? this.db.previewkitEnvironment.findMany({
                      where: {
                          organizationId,
                          githubRepositoryId,
                          prNumber: { in: branches.map((b) => b.prNumber) },
                          status: { notIn: ["torn_down", "failed"] },
                      },
                      select: { prNumber: true, urls: true },
                      orderBy: { updatedAt: "desc" },
                  })
                : Promise.resolve([]),
            this.db.branchDeployment.findMany({
                where: {
                    organizationId,
                    branchId: { in: branches.map((b) => b.branchId) },
                    webDeployment: { isNot: null },
                },
                select: { branchId: true, webDeployment: { select: { url: true } } },
                orderBy: { updatedAt: "desc" },
            }),
        ]);

        const previewkitUrlByPr = new Map<number, string>();
        for (const environment of previewkitEnvironments) {
            if (previewkitUrlByPr.has(environment.prNumber)) continue;
            const url = firstPreviewUrl(environment.urls);
            if (url != null) previewkitUrlByPr.set(environment.prNumber, url);
        }

        const legacyUrlByBranch = new Map<string, string>();
        for (const deployment of legacyDeployments) {
            if (legacyUrlByBranch.has(deployment.branchId)) continue;
            const url = deployment.webDeployment?.url;
            if (url != null && url !== "") legacyUrlByBranch.set(deployment.branchId, url);
        }

        const urlByPr = new Map<number, string>();
        for (const branch of branches) {
            const url = previewkitUrlByPr.get(branch.prNumber) ?? legacyUrlByBranch.get(branch.branchId);
            if (url != null) urlByPr.set(branch.prNumber, url);
        }
        return urlByPr;
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
            // Canceled snapshots are abandoned drafts kept only for observability; they are
            // hidden from user-facing history but stay reachable by id via getSnapshotDetail.
            where: { branchId, branch: { application: { organizationId } }, status: { not: "cancelled" } },
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

        const snapshotIds = snapshots.map((s) => s.id);
        const [changeSummaries, healthBySnapshot, bugCountBySnapshot] = await Promise.all([
            Promise.all(
                snapshots.map((s) => summarizeChangesForSnapshot(this.db, s.id, s.prevSnapshotId, this.logger)),
            ),
            aggregateSnapshotHealth(
                this.db,
                snapshots.map((s) => ({ id: s.id, status: s.status })),
                this.logger,
            ),
            this.countOpenBugsBySnapshot(snapshotIds),
        ]);

        return snapshots.map((snapshot, index) => ({
            ...snapshot,
            changeSummary: changeSummaries[index] as SnapshotChangeSummary,
            health: healthBySnapshot.get(snapshot.id)?.health ?? "unknown",
            healthCounts: healthBySnapshot.get(snapshot.id)?.counts ?? {
                failing: 0,
                passing: 0,
                running: 0,
                setupFailed: 0,
                quarantined: 0,
                notAffected: snapshot._count.testCaseAssignments,
                totalTests: snapshot._count.testCaseAssignments,
            },
            bugCount: bugCountBySnapshot.get(snapshot.id) ?? 0,
        }));
    }

    private async countOpenBugsBySnapshot(snapshotIds: string[]): Promise<Map<string, number>> {
        if (snapshotIds.length === 0) return new Map();

        const issues = await this.db.issue.findMany({
            where: {
                bug: { status: "open" },
                OR: [
                    { generationReview: { is: { generation: { snapshotId: { in: snapshotIds } } } } },
                    { runReview: { is: { run: { assignment: { snapshotId: { in: snapshotIds } } } } } },
                ],
            },
            select: {
                bugId: true,
                generationReview: { select: { generation: { select: { snapshotId: true } } } },
                runReview: { select: { run: { select: { assignment: { select: { snapshotId: true } } } } } },
            },
        });

        const bugIdsBySnapshot = new Map<string, Set<string>>();
        for (const issue of issues) {
            if (issue.bugId == null) continue;
            const snapshotId =
                issue.generationReview?.generation.snapshotId ?? issue.runReview?.run.assignment.snapshotId;
            if (snapshotId == null) continue;
            let bugIds = bugIdsBySnapshot.get(snapshotId);
            if (bugIds == null) {
                bugIds = new Set();
                bugIdsBySnapshot.set(snapshotId, bugIds);
            }
            bugIds.add(issue.bugId);
        }

        return new Map([...bugIdsBySnapshot].map(([snapshotId, bugIds]) => [snapshotId, bugIds.size]));
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
                // Cached GitHub PR metadata. The detail page falls back to this title when the live
                // GitHub fetch is unavailable, matching the PR list (which always reads from cache).
                prInfo: { select: { prNumber: true, prTitle: true } },
            },
        });

        if (branch == null) throw new NotFoundError("Pull request not found");
        if (branch.prInfo == null) throw new InternalError("Branch has no PR info");

        const { prInfo, ...rest } = branch;
        return { ...rest, prNumber: prInfo.prNumber, prTitle: prInfo.prTitle ?? undefined };
    }

    async getSnapshotDetail(
        snapshotId: string,
        organizationId: string,
        // Defaults to the full payload so any internal caller keeps prior behavior. The tRPC router
        // opts out of the workflow/refinement-loop work for aggregate callers (e.g. the PR overview
        // card, which fans this out across every snapshot in the PR).
        options: { includeWorkflow: boolean; includeRefinementLoop: boolean } = {
            includeWorkflow: true,
            includeRefinementLoop: true,
        },
    ) {
        this.logger.info("Getting snapshot detail", { snapshotId, ...options });

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
                                rejectionReasoning: true,
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

        const temporalWorkflowPromise: Promise<WorkflowRef | undefined> = options.includeWorkflow
            ? findLatestWorkflowBySnapshotId(snapshotId).catch((error) => {
                  this.logger.warn("Could not resolve Temporal workflow for snapshot", { snapshotId, error });
                  return undefined;
              })
            : Promise.resolve(undefined);

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

        const [changes, temporalWorkflow, refinementLoop, firstIterationReasoning] = await Promise.all([
            getChangesForSnapshot(this.db, snapshotId, snapshot.prevSnapshotId, this.logger),
            temporalWorkflowPromise,
            options.includeRefinementLoop
                ? loadRefinementLoop(this.db, snapshotId, this.logger)
                : Promise.resolve(undefined),
            // The first iteration's reasoning is only rendered on the single-snapshot pipeline strip,
            // so it loads alongside the refinement loop. The lean PR-overview fan-out (one detail per
            // snapshot) leaves it out to avoid a per-snapshot query.
            options.includeRefinementLoop
                ? loadFirstIterationReasoning(this.db, snapshotId, this.logger)
                : Promise.resolve(undefined),
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
            firstIterationReasoning,
            temporalWorkflow,
            testCandidates: diffsJob.testCandidates.map((c) => ({
                ...c,
                generation:
                    c.acceptedTestCase != null ? (candidateGenByTestCaseId.get(c.acceptedTestCase.id) ?? null) : null,
                run: c.acceptedTestCase != null ? (candidateRunByTestCaseId.get(c.acceptedTestCase.id) ?? null) : null,
            })),
        };

        const [executedTests, assignmentsForHealth] = await Promise.all([
            listExecutedTestsForSnapshot(this.db, snapshotId),
            this.db.testCaseAssignment.findMany({
                where: { snapshotId },
                select: { testCaseId: true, quarantineIssueId: true },
            }),
        ]);
        const counts = this.computeHealthCounts(assignmentsForHealth, executedTests);
        const health = computeSnapshotHealth(snapshot.status, counts);

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

    private computeHealthCounts(
        assignments: Array<{ testCaseId: string; quarantineIssueId: string | null }>,
        executedTests: SnapshotExecutedTest[],
    ): SnapshotHealthCounts {
        const quarantinedSet = new Set(assignments.filter((a) => a.quarantineIssueId != null).map((a) => a.testCaseId));
        const tally = tallyExecutedTests(executedTests, quarantinedSet);

        const quarantined = quarantinedSet.size;
        const replayed = tally.passing + tally.failing + tally.setupFailed + tally.running;
        const totalTests = assignments.length;
        const notAffected = Math.max(totalTests - quarantined - replayed, 0);

        return {
            failing: tally.failing,
            passing: tally.passing,
            running: tally.running,
            setupFailed: tally.setupFailed,
            quarantined,
            notAffected,
            totalTests,
        };
    }

    async getSnapshotReport(snapshotId: string, organizationId: string): Promise<SnapshotReport> {
        this.logger.info("Getting snapshot report", {
            snapshotId,
        });

        return loadSnapshotReport({
            db: this.db,
            github: this.github,
            storageProvider: this.storageProvider,
            snapshotId,
            organizationId,
            parentLogger: this.logger,
        });
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

        const rawTestSuite = await fetchTestSuiteInfo(this.db, branch.activeSnapshotId);
        const testSuite = await signTestSuiteScreenshots(rawTestSuite, this.storageProvider);
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
                    // Exclude cancelled snapshots so the PR-wide rollup reflects the real
                    // lineage; a cancelled draft must never become the latest rollup target.
                    where: { status: { not: "cancelled" } },
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

type PullRequestStateFilter = "open" | "closed" | "merged";

/**
 * Builds the `prInfo` relation filter for a given PR state. We match the cached
 * `prState` exactly and do NOT fold unknown (null) state into "open": before the cache
 * is populated, treating null as open swamped the Open tab with historic closed/merged
 * PRs. The revalidation now classifies every tracked PR (the open-PR list is
 * authoritative - anything not in it is marked closed), so null is only a brief transient
 * state for a freshly tracked PR until the next revalidation, after which it shows under
 * its real tab.
 */
function prInfoStateFilter(state: PullRequestStateFilter): Prisma.FeatureBranchInfoWhereInput {
    return { prState: state };
}

const PreviewUrlsSchema = z.record(z.string(), z.string());

function firstPreviewUrl(urls: unknown): string | undefined {
    const parsed = PreviewUrlsSchema.safeParse(urls);
    if (!parsed.success) return undefined;
    for (const url of Object.values(parsed.data)) {
        if (url.length > 0) return url;
    }
    return undefined;
}
