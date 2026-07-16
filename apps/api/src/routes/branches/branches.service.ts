import {
    aggregateSnapshotHealth,
    buildCheckpointSummary,
    computeFailingByKind,
    computeSnapshotHealth,
    countOpenBugsBySnapshot,
    failingExecutionIds,
    type FailingByKind,
    listExecutedTestsForSnapshot,
    loadIssueKindsForExecutions,
    type SnapshotExecutedTest,
    type SnapshotHealthCounts,
    tallyExecutedTests,
} from "@autonoma/checkpoint";
import type { Prisma } from "@autonoma/db";
import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, InternalError, NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import {
    getChangesForSnapshot,
    summarizeChangesForSnapshot,
    fetchTestSuiteInfo,
    type SnapshotChangeSummary,
} from "@autonoma/test-updates";
import type {
    CheckpointPresentationSummary,
    InvestigationFinding,
    InvestigationReportData,
    InvestigationRunStep,
    SnapshotReport,
} from "@autonoma/types";
import { findLatestWorkflowBySnapshotId, type WorkflowRef } from "@autonoma/workflow";
import { z } from "zod";
import type { GitHubInstallationService } from "../../github/github-installation.service";
import type { PullRequestCacheService } from "../../github/pull-request-cache.service";
import { Service } from "../service";
import { loadCreatedTests, type SnapshotCreatedTest } from "./created-tests";
import { loadFirstIterationReasoning } from "./first-iteration-reasoning";
import { loadRefinementLoop } from "./refinement-loop";
import { loadSnapshotReport } from "./snapshot-report";
import { computeTestSuiteChanges, emptyTestSuiteChanges } from "./test-suite-changes";

export type { TestSuiteChangeRow } from "./test-suite-changes";

/** Signed-URL lifetime for a finding's screenshot/video - short, re-signed on every page load. */
const INVESTIGATION_MEDIA_TTL_SECONDS = 60 * 60;

/**
 * A report should surface an entry point only when it leads somewhere useful: it either has renderable island
 * data (`appSlug` is set - `getInvestigationReportData` returns null otherwise) or is actively running (the
 * live-progress state). This deliberately hides pre-island reports (appSlug null, S3-markdown only) until the
 * backfill migrates them in, and failed rows that never produced a report - both would otherwise open an empty
 * "not available" page. Applied to BOTH presence reads so the entry point and the report page never disagree.
 */
const RENDERABLE_OR_LIVE_REPORT: Prisma.InvestigationReportWhereInput = {
    OR: [{ appSlug: { not: null } }, { status: "running" }],
};

/**
 * Finding categories that make a report "warning"-level (amber entry point): a scenario-data problem or an
 * environment/provisioning failure - actionable, but not a confirmed client bug. Client bugs (red) are counted
 * separately via the denormalized `clientBugCount`; everything else is neutral (gray). Kept as a filtered
 * relation count on the presence reads so the entry point can be colored without loading the findings.
 */
const WARNING_FINDING_CATEGORIES = ["scenario_issue", "environment_failure"];

/** One PR's investigation entry-point presence (drives the colored pill on the Home + PR lists). */
export interface InvestigationPresenceEntry {
    snapshotId: string;
    clientBugCount: number;
    /** Count of scenario/environment-failure findings - the amber (warning) signal. */
    warningCount: number;
    status: string;
    stage?: string;
}

/** Columns read from an InvestigationFinding row to reconstruct the UI's InvestigationFinding shape. */
const investigationFindingSelect = {
    findingKey: true,
    slug: true,
    category: true,
    confidence: true,
    planFidelity: true,
    falsePositiveRisk: true,
    headline: true,
    whatHappened: true,
    observedAppIssues: true,
    remediation: true,
    rootCause: true,
    suggestedFixDiff: true,
    plan: true,
    runSuccess: true,
    stepCount: true,
    runSteps: true,
    runTrace: true,
    evidence: true,
    videoKey: true,
    screenshotKey: true,
    error: true,
    coveredSlugs: true,
} satisfies Prisma.InvestigationFindingSelect;

const investigationSuggestedTestSelect = {
    name: true,
    instruction: true,
    reasoning: true,
    validationPassed: true,
    validationIterations: true,
    validationFailureReason: true,
} satisfies Prisma.InvestigationSuggestedTestSelect;

type InvestigationFindingRow = Prisma.InvestigationFindingGetPayload<{ select: typeof investigationFindingSelect }>;

/** Reconstruct the UI's InvestigationFinding from a persisted row (media keys are signed separately, on read). */
function rowToFinding(row: InvestigationFindingRow): InvestigationFinding {
    return {
        id: row.findingKey,
        slug: row.slug,
        category: row.category,
        confidence: row.confidence ?? undefined,
        planFidelity: row.planFidelity ?? undefined,
        falsePositiveRisk: row.falsePositiveRisk ?? undefined,
        headline: row.headline,
        whatHappened: row.whatHappened ?? undefined,
        observedAppIssues: row.observedAppIssues ?? undefined,
        remediation: row.remediation ?? undefined,
        rootCause: row.rootCause ?? undefined,
        suggestedFixDiff: row.suggestedFixDiff ?? undefined,
        evidence: row.evidence ?? [],
        plan: row.plan ?? undefined,
        runSuccess: row.runSuccess ?? undefined,
        stepCount: row.stepCount ?? undefined,
        runSteps: row.runSteps ?? undefined,
        // Each step's screenshotUrl is still a raw s3:// key here; signFindingMedia signs them on read.
        runTrace: row.runTrace ?? undefined,
        // Stored s3:// keys; signFindingMedia turns these into browser-openable URLs.
        videoUrl: row.videoKey ?? undefined,
        finalScreenshotUrl: row.screenshotKey ?? undefined,
        error: row.error ?? undefined,
        coveredSlugs: row.coveredSlugs ?? undefined,
    };
}

export class BranchesService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly github: GitHubInstallationService,
        private readonly storageProvider: StorageProvider,
        private readonly prCache: PullRequestCacheService,
    ) {
        super();
    }

    /**
     * A lightweight presence + counts check for the snapshot page's "Investigation" entry point (does a report
     * exist, and how many bugs). DB-only - there is no S3 involved. Internal/@autonoma.app surface only; returns
     * undefined when the shadow job has not produced a report for this snapshot. Org-scoped like getSnapshotReport.
     */
    async getInvestigationReport(snapshotId: string, organizationId: string) {
        this.logger.info("Getting investigation report", { extra: { snapshotId } });
        try {
            // Post-#1204 the report lives on the detached investigation twin (hop the pairing FK); pre-#1204
            // investigations ran on the PR snapshot itself and keyed the report directly to it. Match either so
            // historical PRs still surface their report - legacy leg to be dropped once old reports age out.
            // If BOTH exist for one PR (a legacy direct report + a later twin), prefer the twin: it is always the
            // newer row, so createdAt desc picks it. createdAt (not updatedAt) because the backfill bumps
            // updatedAt on legacy rows, which would wrongly favor a just-backfilled legacy report.
            const report = await this.db.investigationReport.findFirst({
                where: {
                    organizationId,
                    AND: [
                        { OR: [{ snapshot: { investigationParent: { id: snapshotId } } }, { snapshotId }] },
                        RENDERABLE_OR_LIVE_REPORT,
                    ],
                },
                orderBy: { createdAt: "desc" },
                select: { testCount: true, clientBugCount: true, status: true, updatedAt: true },
            });
            if (report == null) return undefined;
            return {
                testCount: report.testCount,
                clientBugCount: report.clientBugCount,
                status: report.status,
                updatedAt: report.updatedAt,
            };
        } catch (error) {
            // Optional internal surface - a failure here (table not yet migrated in this env, etc.) must never
            // error the PR view. Degrade to "no report" so the entry point simply doesn't appear.
            this.logger.warn("Could not load investigation report; treating as absent", {
                extra: { snapshotId },
                err: error,
            });
            return undefined;
        }
    }

    /**
     * Batched presence for the PR-list entry points (Home + PR list): given the active snapshot ids of many PRs,
     * return which ones have an investigation report and its bug count + lifecycle status. Batched deliberately -
     * a per-PR fetch would N+1 the list. Matches the twin's report (via the pairing FK) or a legacy report keyed
     * directly to the PR snapshot, and keys the result back to the PR snapshot id the UI routes on. Internal/
     * @autonoma.app only; degrades to an empty list on any failure. Org-scoped.
     */
    async getInvestigationReportsForSnapshots(snapshotIds: string[], organizationId: string) {
        this.logger.info("Getting investigation reports for snapshots", { extra: { count: snapshotIds.length } });
        if (snapshotIds.length === 0) return [];
        try {
            const requested = new Set(snapshotIds);
            const reports = await this.db.investigationReport.findMany({
                where: {
                    organizationId,
                    AND: [
                        {
                            OR: [
                                { snapshotId: { in: snapshotIds } },
                                { snapshot: { investigationParent: { id: { in: snapshotIds } } } },
                            ],
                        },
                        RENDERABLE_OR_LIVE_REPORT,
                    ],
                },
                // Newest first so the first row seen for a PR snapshot (the twin, post-#1204) wins over an older
                // legacy row for the same PR.
                orderBy: { createdAt: "desc" },
                select: {
                    snapshotId: true,
                    clientBugCount: true,
                    status: true,
                    stage: true,
                    snapshot: { select: { investigationParent: { select: { id: true } } } },
                    _count: { select: { findings: { where: { category: { in: WARNING_FINDING_CATEGORIES } } } } },
                },
            });

            const seen = new Set<string>();
            const presence: InvestigationPresenceEntry[] = [];
            for (const report of reports) {
                const parentId = report.snapshot.investigationParent?.id;
                const prSnapshotId = parentId != null && requested.has(parentId) ? parentId : report.snapshotId;
                if (!requested.has(prSnapshotId) || seen.has(prSnapshotId)) continue;
                seen.add(prSnapshotId);
                presence.push({
                    snapshotId: prSnapshotId,
                    clientBugCount: report.clientBugCount,
                    warningCount: report._count.findings,
                    status: report.status,
                    stage: report.stage ?? undefined,
                });
            }
            return presence;
        } catch (error) {
            // Optional internal surface - a failure here must never sink the PR list. Degrade to "none".
            this.logger.warn("Could not load investigation reports for snapshots; treating as none", { err: error });
            return [];
        }
    }

    /**
     * The structured investigation report for the in-app "View investigation" page. Reads the queryable island
     * tables the worker persists (InvestigationReport + findings/suggested) and re-signs each finding's s3://
     * media into browser-openable URLs - the DB is the single source of truth (no S3 report blob). Reports
     * written before the island cutover have no denormalized header until the backfill script runs; those return
     * null here (the page shows a graceful "not available"). Internal/@autonoma.app only; degrades to null on any
     * failure. Org-scoped.
     *
     * Returns `null`, never `undefined`, for absence: this is consumed by a React Query query whose queryFn must
     * not resolve to `undefined` (React Query throws "data is undefined" and crashes the page's error boundary,
     * before the component's graceful `data == null` branch can render). `null` is a valid resolved value.
     */
    async getInvestigationReportData(
        snapshotId: string,
        organizationId: string,
    ): Promise<InvestigationReportData | null> {
        this.logger.info("Getting investigation report data", { extra: { snapshotId } });
        try {
            // Twin's report (post-#1204) or a legacy report keyed directly to the PR snapshot (pre-#1204), so
            // historical PRs keep their rich report. When both exist for one PR, prefer the twin - it is the newer
            // row, so createdAt desc picks it (createdAt, not updatedAt, since the backfill bumps updatedAt on
            // legacy rows). Legacy leg to be dropped once old reports age out.
            const report = await this.db.investigationReport.findFirst({
                where: {
                    organizationId,
                    OR: [{ snapshot: { investigationParent: { id: snapshotId } } }, { snapshotId }],
                },
                orderBy: { createdAt: "desc" },
                select: {
                    client: true,
                    appSlug: true,
                    prNumber: true,
                    prTitle: true,
                    prBody: true,
                    repoFullName: true,
                    commitSha: true,
                    deployed: true,
                    findings: { orderBy: { displayOrder: "asc" }, select: investigationFindingSelect },
                    suggestedTests: { orderBy: { displayOrder: "asc" }, select: investigationSuggestedTestSelect },
                },
            });
            if (report == null) return null;

            // The island persister always writes the denormalized header (appSlug is a required field of the
            // report data), so appSlug != null reliably marks an island report - even one with zero findings.
            // Pre-island rows never had a header; they render only once the backfill script migrates them in.
            if (report.appSlug == null) return null;

            const findings = await Promise.all(
                report.findings.map((finding) => this.signFindingMedia(rowToFinding(finding))),
            );
            return {
                client: report.client ?? "",
                appSlug: report.appSlug,
                prNumber: report.prNumber ?? 0,
                prTitle: report.prTitle ?? undefined,
                prBody: report.prBody ?? undefined,
                repoFullName: report.repoFullName ?? undefined,
                commitSha: report.commitSha ?? undefined,
                findings,
                suggested: report.suggestedTests.map((test) => ({
                    name: test.name,
                    instruction: test.instruction,
                    reasoning: test.reasoning,
                    validation:
                        test.validationPassed != null
                            ? {
                                  passed: test.validationPassed,
                                  iterations: test.validationIterations ?? 0,
                                  failureReason: test.validationFailureReason ?? undefined,
                              }
                            : undefined,
                })),
                deployed: report.deployed ?? undefined,
            };
        } catch (error) {
            // A transient DB error must never error the page - degrade to "no rich report" and let the page
            // render its graceful fallback.
            this.logger.warn("Could not load structured investigation report; treating as absent", {
                extra: { snapshotId },
                err: error,
            });
            return null;
        }
    }

    /**
     * The latest investigation report for a pull request, resolved from `applicationId + prNumber` rather than a
     * snapshot id. Picks the PR's newest primary checkpoint (twins and cancelled drafts excluded, mirroring
     * `listSnapshots`) and loads its report via `getInvestigationReportData` (which handles the twin/legacy report
     * and signs the media). Returns null when the PR has no branch, no checkpoint, or no renderable report yet.
     * Org-scoped. Used by the MCP `get_investigation` tool so a coding agent can pull the findings by repo + PR
     * without an in-app login.
     */
    async getInvestigationReportForPr(
        applicationId: string,
        prNumber: number,
        organizationId: string,
    ): Promise<InvestigationReportData | null> {
        this.logger.info("Getting investigation report for PR", { applicationId, prNumber });
        const branch = await this.db.branch.findFirst({
            where: { applicationId, prInfo: { prNumber }, application: { organizationId } },
            select: { id: true },
        });
        if (branch == null) return null;

        const snapshot = await this.db.branchSnapshot.findFirst({
            where: { branchId: branch.id, status: { not: "cancelled" }, investigationParent: { is: null } },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });
        if (snapshot == null) return null;

        return this.getInvestigationReportData(snapshot.id, organizationId);
    }

    /** Re-sign a finding's stored s3:// screenshot/video keys (finding media + every run-trace step) into URLs. */
    private async signFindingMedia(finding: InvestigationFinding): Promise<InvestigationFinding> {
        const finalScreenshotUrl =
            finding.finalScreenshotUrl != null
                ? await this.storageProvider.getSignedUrl(finding.finalScreenshotUrl, INVESTIGATION_MEDIA_TTL_SECONDS)
                : undefined;
        const videoUrl =
            finding.videoUrl != null
                ? await this.storageProvider.getSignedUrl(finding.videoUrl, INVESTIGATION_MEDIA_TTL_SECONDS)
                : undefined;
        const runTrace =
            finding.runTrace != null
                ? await Promise.all(finding.runTrace.map((step) => this.signStep(step)))
                : undefined;
        return { ...finding, finalScreenshotUrl, videoUrl, runTrace };
    }

    /** Sign one run-trace step's stored screenshot key; the coordinates and labels pass through untouched. */
    private async signStep(step: InvestigationRunStep): Promise<InvestigationRunStep> {
        const screenshotUrl =
            step.screenshotUrl != null
                ? await this.storageProvider.getSignedUrl(step.screenshotUrl, INVESTIGATION_MEDIA_TTL_SECONDS)
                : undefined;
        return { ...step, screenshotUrl };
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
            countOpenBugsBySnapshot(
                this.db,
                activeSnapshots.map((s) => s.id),
            ),
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
                          summary: summaryFromHealth(
                              activeSnapshot.status,
                              healthBySnapshot.get(activeSnapshot.id),
                              bugCountBySnapshot.get(activeSnapshot.id) ?? 0,
                          ),
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
            // Investigation twins (detached A/B snapshots, identified by a non-null investigationParent)
            // are likewise hidden - they are not part of the branch's user-facing lineage.
            where: {
                branchId,
                branch: { application: { organizationId } },
                status: { not: "cancelled" },
                investigationParent: { is: null },
            },
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
            countOpenBugsBySnapshot(this.db, snapshotIds),
        ]);

        return snapshots.map((snapshot, index) => {
            const changeSummary = changeSummaries[index] as SnapshotChangeSummary;
            const openBugCount = bugCountBySnapshot.get(snapshot.id) ?? 0;
            return {
                ...snapshot,
                changeSummary,
                health: healthBySnapshot.get(snapshot.id)?.health ?? "unknown",
                healthCounts: healthBySnapshot.get(snapshot.id)?.counts ?? {
                    failing: 0,
                    passing: 0,
                    running: 0,
                    setupFailed: 0,
                    notAffected: snapshot._count.testCaseAssignments,
                    totalTests: snapshot._count.testCaseAssignments,
                },
                bugCount: openBugCount,
                summary: summaryFromHealth(snapshot.status, healthBySnapshot.get(snapshot.id), openBugCount, {
                    suiteChangeCount: changeSummary.added + changeSummary.removed + changeSummary.updated,
                }),
            };
        });
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
        const { diffsJob, branch: _branch, ...snapshotRest } = snapshot;
        const flatSnapshot = {
            ...snapshotRest,
            branch: { ...branchRest, prNumber: prInfo?.prNumber },
        };

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

        const diffsJobWithMeta = {
            ...diffsJob,
            firstIterationReasoning,
            temporalWorkflow,
        };

        // Created tests are the assignments added vs. the previous snapshot; resolve them
        // from the already-computed changes so a single diff drives both surfaces. The
        // generation/run inspector they carry is only rendered on the single-snapshot page,
        // so it loads alongside the refinement loop - the lean PR-overview fan-out leaves it
        // out (the overview reads added-test runs from executedTests) to avoid extra
        // per-snapshot queries.
        const createdTestCaseIds = changes.filter((c) => c.type === "added").map((c) => c.testCaseId);
        const createdTestsPromise: Promise<SnapshotCreatedTest[]> = options.includeRefinementLoop
            ? loadCreatedTests(this.db, snapshotId, createdTestCaseIds, this.logger)
            : Promise.resolve([]);

        const [executedTests, assignmentCount, createdTests, openBugCountBySnapshot] = await Promise.all([
            listExecutedTestsForSnapshot(this.db, snapshotId),
            this.db.testCaseAssignment.count({ where: { snapshotId } }),
            createdTestsPromise,
            countOpenBugsBySnapshot(this.db, [snapshotId]),
        ]);
        const counts = this.computeHealthCounts(assignmentCount, executedTests);
        const health = computeSnapshotHealth(snapshot.status, counts);

        // Attribute failing tests that carry a linked Issue to engine vs app by Issue kind. The
        // lookup no-ops (no query) when nothing failed, keeping the all-green path query-flat.
        const { generationIds } = failingExecutionIds([executedTests]);
        const issueKinds = await loadIssueKindsForExecutions(this.db, generationIds);
        const failingByKind = computeFailingByKind(executedTests, issueKinds);
        const suiteChangeCount = changes.filter(
            (c) => c.type === "added" || c.type === "updated" || c.type === "removed",
        ).length;
        const summary = buildCheckpointSummary({
            snapshotStatus: snapshot.status,
            counts,
            openBugCount: openBugCountBySnapshot.get(snapshotId) ?? 0,
            failingByKind,
            suiteChangeCount,
        });

        return {
            snapshot: flatSnapshot,
            changes,
            diffsJob: diffsJobWithMeta,
            createdTests,
            refinementLoop,
            health,
            healthCounts: counts,
            summary,
            executedTests,
        };
    }

    private computeHealthCounts(totalTests: number, executedTests: SnapshotExecutedTest[]): SnapshotHealthCounts {
        const tally = tallyExecutedTests(executedTests);

        const replayed = tally.passing + tally.failing + tally.setupFailed + tally.running;
        const notAffected = Math.max(totalTests - replayed, 0);

        return {
            failing: tally.failing,
            passing: tally.passing,
            running: tally.running,
            setupFailed: tally.setupFailed,
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

        // A branch can have no active checkpoint yet; return an explicit empty state.
        if (branch.activeSnapshotId == null) {
            return {
                hasActiveCheckpoint: false as const,
                branch: { id: branch.id, name: branch.name, prNumber: branch.prInfo?.prNumber },
            };
        }

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
            hasActiveCheckpoint: true as const,
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
                    // Investigation twins are detached A/B snapshots, not part of the lineage either.
                    where: { status: { not: "cancelled" }, investigationParent: { is: null } },
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

// Maps a bulk `aggregateSnapshotHealth` result into the shared presentation summary.
function summaryFromHealth(
    snapshotStatus: string,
    healthResult: { counts: SnapshotHealthCounts; failingByKind: FailingByKind } | undefined,
    openBugCount: number,
    options?: { issueOccurrenceCount?: number; suiteChangeCount?: number },
): CheckpointPresentationSummary | undefined {
    if (healthResult == null) return undefined;
    return buildCheckpointSummary({
        snapshotStatus,
        counts: healthResult.counts,
        openBugCount,
        issueOccurrenceCount: options?.issueOccurrenceCount,
        failingByKind: healthResult.failingByKind,
        suiteChangeCount: options?.suiteChangeCount,
    });
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
