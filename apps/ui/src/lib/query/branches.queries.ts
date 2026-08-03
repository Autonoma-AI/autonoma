import { type QueryClient, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { env } from "env";
import { useAuth } from "lib/auth";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import type { RouterOutputs } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

export type PullRequestStateFilter = "open" | "closed" | "merged";

/**
 * A lightweight presence + counts check for the snapshot page's "Investigation" entry point (does a report
 * exist, and how many bugs). Internal-only: the query is enabled only for @autonoma.app users, and the API
 * procedure also enforces it. Returns undefined when no shadow report exists. Not a suspense query (optional).
 */
export function useInvestigationReport(snapshotId: string) {
    const { user } = useAuth();
    const isInternal = user?.email?.endsWith(`@${env.VITE_INTERNAL_DOMAIN}`) ?? false;
    return useQuery({
        ...trpc.branches.investigationReport.queryOptions({ snapshotId }),
        enabled: isInternal,
    });
}

/**
 * The structured investigation report (findings + signed media) for the in-app "View investigation" page.
 * Internal-only and enforced by the API procedure. A plain (non-suspense) query because the value is legitimately
 * undefined when no rich report exists for the snapshot (not yet backfilled / a parse failure) - the page renders
 * a graceful fallback for that, which useSuspenseQuery cannot express (it throws on undefined data).
 */
export function useInvestigationReportData(snapshotId: string) {
    return useQuery(trpc.branches.investigationReportData.queryOptions({ snapshotId }));
}

/**
 * Batched investigation presence for the PR-list entry points (Home + PR list). Given the PRs' active snapshot
 * ids, returns which have a report (bug count + lifecycle status). Internal-only: enabled only for @autonoma.app
 * users (the API procedure also enforces it), so non-internal users get an empty list and no entry points render.
 * The UI keys the result by snapshot id for O(1) lookup per row.
 */
export interface InvestigationPresence {
    clientBugCount: number;
    /** Count of scenario/environment-failure findings - the amber (warning) signal for the entry point. */
    warningCount: number;
    status: string;
    /** The coarse in-flight stage while status is "running" (undefined once terminal). */
    stage?: string;
}

export interface InvestigationPresenceResult {
    bySnapshot: Map<string, InvestigationPresence>;
    /** True while the (internal-only) presence query is in flight - the entry points show skeletons meanwhile. */
    isLoading: boolean;
    /** Whether the entry points apply at all (internal user only). */
    enabled: boolean;
}

/**
 * Takes the application and the pull-request state the list is showing, NOT the snapshot ids on screen: the
 * server already knows which snapshots those are, and shipping a few hundred ids back to it is what pushed a
 * batched tRPC GET past the edge's URL limit.
 */
export function useInvestigationReportsBySnapshot(state: PullRequestStateFilter): InvestigationPresenceResult {
    const currentApp = useCurrentApplication();
    const { user } = useAuth();
    const enabled = user?.email?.endsWith(`@${env.VITE_INTERNAL_DOMAIN}`) ?? false;
    const { data, isLoading } = useQuery({
        ...trpc.branches.investigationReportsForApplication.queryOptions({ applicationId: currentApp.id, state }),
        enabled,
    });
    return {
        bySnapshot: new Map((data ?? []).map((entry) => [entry.snapshotId, entry])),
        // `isLoading` is true only for an enabled-but-unsettled query, so a non-internal user never shows skeletons.
        isLoading: enabled && isLoading,
        enabled,
    };
}

export type InvestigationEntryTone = "bug" | "warning" | "neutral";

/**
 * Severity color for the PR-list entry point: red when the run found one or more client bugs, amber for a
 * scenario/environment failure (actionable, not a confirmed bug), gray otherwise (clean, running, or failed).
 */
export function investigationEntryTone(presence: InvestigationPresence): InvestigationEntryTone {
    if (presence.clientBugCount > 0) return "bug";
    if (presence.warningCount > 0) return "warning";
    return "neutral";
}

/**
 * Entry-point text color by severity, single-sourced for the Home + PR-list entry points: red for bugs, amber
 * for scenario/environment failures, gray otherwise. Includes the hover color so a bug/warning link keeps its
 * tone on hover (only the neutral link brightens to primary).
 */
export const INVESTIGATION_TONE_CLASS: Record<InvestigationEntryTone, string> = {
    bug: "text-status-critical hover:text-status-critical",
    warning: "text-status-warn hover:text-status-warn",
    neutral: "text-text-secondary hover:text-text-primary",
};

const INVESTIGATION_STAGE_LABEL: Record<string, string> = {
    selecting: "selecting tests",
    running: "running tests",
    reporting: "writing report",
};

/**
 * The short label shown on the PR entry point: the in-flight stage while running (e.g. "running tests"), the bug
 * count once complete, or a neutral "view" for a clean completed report.
 */
export function investigationEntryLabel(presence: InvestigationPresence): string {
    if (presence.status === "running") return INVESTIGATION_STAGE_LABEL[presence.stage ?? ""] ?? "running";
    if (presence.status === "failed") return "failed";
    if (presence.clientBugCount > 0) {
        return `${presence.clientBugCount} ${presence.clientBugCount === 1 ? "bug" : "bugs"}`;
    }
    return "view";
}

export async function ensureInvestigationReportData(queryClient: QueryClient, snapshotId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.investigationReportData.queryOptions({ snapshotId }));
}

/** The AnalysisJob lifecycle status, mirrored from the router output (the db enum is not importable here). */
export type AnalysisJobStatus = NonNullable<RouterOutputs["branches"]["analysisJob"]>["status"];

/**
 * The authoritative analysis report (the Reporter's prose + summary, and this run's findings) for a snapshot,
 * `null` for a diffs snapshot. A suspense query prefetched in the route loaders.
 *
 * Pass the run's `jobStatus` to keep the query polling while a run that has not produced a report yet is still
 * expected to - `running`, or `completed` but not yet observed (settlement writes the report before it flips the
 * job, so the completed-with-no-report window is transient and this closes it). A `failed` run never produces a
 * report and a diffs snapshot has no job, so both settle to no polling. Content-only callers (finding detail, the
 * changes list) omit `jobStatus` and never poll - they render a report a page above has already settled.
 */
export function useAnalysisReport(snapshotId: string, opts?: { jobStatus?: AnalysisJobStatus }) {
    const jobStatus = opts?.jobStatus;
    return useSuspenseQuery({
        ...trpc.branches.analysisReport.queryOptions({ snapshotId }),
        refetchInterval: (query) =>
            query.state.data == null && jobStatus != null && jobStatus !== "failed" ? 5000 : false,
        refetchIntervalInBackground: true,
    });
}

/** True when the snapshot has an authoritative analysis report (drives the authoritative changes-detail layout). */
export function useIsAuthoritativeSnapshot(snapshotId: string): boolean {
    const { data } = useAnalysisReport(snapshotId);
    return data != null;
}

/** Returns the report so a loader can chain the branch-scoped reads that need its `branchId`. */
export async function ensureAnalysisReportData(queryClient: QueryClient, snapshotId: string) {
    return await ensureAPIQueryData(queryClient, trpc.branches.analysisReport.queryOptions({ snapshotId }));
}

/**
 * The authoritative `AnalysisJob` lifecycle for a snapshot (null for a diffs snapshot). Presence identifies an
 * authoritative PR snapshot before any report exists, so the PR page can branch to the new layout and show the
 * run's status while findings are still being produced. Polls while the job is running so a terminal transition
 * (completed/failed) is reflected without a manual reload.
 */
export function useAnalysisJob(snapshotId: string) {
    return useSuspenseQuery({
        ...trpc.branches.analysisJob.queryOptions({ snapshotId }),
        refetchInterval: (query) => (query.state.data?.status === "running" ? 5000 : false),
        refetchIntervalInBackground: true,
    });
}

export async function ensureAnalysisJobData(queryClient: QueryClient, snapshotId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.analysisJob.queryOptions({ snapshotId }));
}

/**
 * The branch's analysis issues (all statuses, branch-scoped) for the PR page. The open ones drive the
 * issues-first list + verdict headline; resolved ones are included so the report prose's `issue:` tokens can link
 * them. A suspense query; empty for a branch with no issues. Only rendered once the run's report has landed (the
 * job is terminal by then), so it does not poll - the report query drives the page's liveness.
 */
export function useAnalysisIssues(branchId: string) {
    return useSuspenseQuery(trpc.branches.analysisIssues.queryOptions({ branchId }));
}

export async function ensureAnalysisIssuesData(queryClient: QueryClient, branchId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.analysisIssues.queryOptions({ branchId }));
}

/**
 * Everything still unresolved on the application's main branch, already normalized across the analysis-issue and
 * legacy-bug stores by the API. Every "what is broken on main" surface reads this one query, so the overview rail
 * and the main-branch page's problem list cannot disagree about which store is authoritative.
 */
export function useMainOpenProblems(applicationId: string) {
    return useSuspenseQuery(trpc.branches.mainOpenProblems.queryOptions({ applicationId }));
}

export async function ensureMainOpenProblemsData(queryClient: QueryClient, applicationId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.mainOpenProblems.queryOptions({ applicationId }));
}

/**
 * One analysis issue in full (narrative + signed evidence + cross-snapshot finding instances) for the PR-level
 * issue-detail page. A plain (non-suspense) query because the value is legitimately `null` for an unknown or
 * malformed issue - the page renders a graceful not-found for that, which useSuspenseQuery cannot express.
 */
export function useAnalysisIssueDetail(issueId: string) {
    return useQuery(trpc.branches.analysisIssueDetail.queryOptions({ issueId }));
}

export async function ensureAnalysisIssueDetailData(queryClient: QueryClient, issueId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.analysisIssueDetail.queryOptions({ issueId }));
}

/**
 * The per-job issue-set changes (opened / carried-forward / resolved) for a snapshot's analysis run, for the
 * snapshot per-job view. A suspense query; empty groups for a diffs snapshot. Keyed by snapshotId, so the route
 * loader prefetches it in the main batch (see `ensureAnalysisSnapshotIssueChangesData`) and the section paints at
 * mount instead of firing a third serial round-trip behind its Suspense boundary.
 */
export function useAnalysisSnapshotIssueChanges(snapshotId: string) {
    return useSuspenseQuery(trpc.branches.analysisSnapshotIssueChanges.queryOptions({ snapshotId }));
}

export async function ensureAnalysisSnapshotIssueChangesData(queryClient: QueryClient, snapshotId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.analysisSnapshotIssueChanges.queryOptions({ snapshotId }));
}

export function useBranches(state: PullRequestStateFilter = "open") {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(trpc.branches.list.queryOptions({ applicationId: currentApp.id, state }));
}

export async function ensureBranchesData(
    queryClient: QueryClient,
    applicationId: string,
    state: PullRequestStateFilter = "open",
) {
    await ensureAPIQueryData(queryClient, trpc.branches.list.queryOptions({ applicationId, state }));
}

export function useBranchDetail(applicationId: string, branchName: string) {
    return useSuspenseQuery(trpc.branches.detailByName.queryOptions({ applicationId, branchName }));
}

export function useBranchByPr(applicationId: string, prNumber: number) {
    return useSuspenseQuery(trpc.branches.detailByPr.queryOptions({ applicationId, prNumber }));
}

// The branch's rolled-up pipeline status (the same value the PR list shows), for the PR-page and
// main-branch headers. Not polled yet - liveness is deferred; it refreshes on load/navigation.
export function usePrPipelineStatus(applicationId: string, branchId: string) {
    return useSuspenseQuery(trpc.branches.pipelineStatusByBranchId.queryOptions({ applicationId, branchId }));
}

export async function ensurePrPipelineStatusData(queryClient: QueryClient, applicationId: string, branchId: string) {
    await ensureAPIQueryData(
        queryClient,
        trpc.branches.pipelineStatusByBranchId.queryOptions({ applicationId, branchId }),
    );
}

export async function ensureBranchByPrData(queryClient: QueryClient, applicationId: string, prNumber: number) {
    return await ensureAPIQueryData(queryClient, trpc.branches.detailByPr.queryOptions({ applicationId, prNumber }));
}

export async function ensureBranchData(queryClient: QueryClient, applicationId: string, branchName: string) {
    return await ensureAPIQueryData(
        queryClient,
        trpc.branches.detailByName.queryOptions({ applicationId, branchName }),
    );
}

export async function ensureBranchSnapshotId(
    queryClient: QueryClient,
    applicationId: string,
    branchName: string,
): Promise<string | undefined> {
    const data = await ensureBranchData(queryClient, applicationId, branchName);
    return data.activeSnapshot.id;
}

export function useSnapshotHistory(branchId: string) {
    return useSuspenseQuery(trpc.branches.snapshotHistory.queryOptions({ branchId }));
}

export async function ensureSnapshotHistoryData(queryClient: QueryClient, branchId: string) {
    return await ensureAPIQueryData(queryClient, trpc.branches.snapshotHistory.queryOptions({ branchId }));
}

type SnapshotHistoryEntry = RouterOutputs["branches"]["snapshotHistory"][number];

/** A branch's snapshot history sorted newest-first (the list is not guaranteed ordered by the server). */
export function sortSnapshotsNewestFirst(snapshots: SnapshotHistoryEntry[]): SnapshotHistoryEntry[] {
    return [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** The newest snapshot in a branch's history, or undefined for a PR with no snapshots yet. */
export function latestSnapshotOf(snapshots: SnapshotHistoryEntry[]): SnapshotHistoryEntry | undefined {
    return sortSnapshotsNewestFirst(snapshots)[0];
}

const TERMINAL_DIFFS_JOB_STATUSES = new Set(["completed", "failed"]);
const INCOMPLETE_GENERATION_STATUSES = new Set(["pending", "queued", "running"]);

// The Temporal workflow link and refinement loop are only shown on the single-checkpoint page.
// Aggregate callers (the PR overview card) omit them so the server skips an external Temporal call
// and an extra query per snapshot. Lean callers keep the `{ snapshotId }` key so they share one
// cache entry; the full page uses a distinct key.
export type SnapshotDetailOptions = { includeWorkflow?: boolean; includeRefinementLoop?: boolean };

// The single-checkpoint page (and its nested changes routes) render the workflow link and refinement
// loop, so they request the full payload and share one cache entry under this key.
export const FULL_SNAPSHOT_DETAIL: SnapshotDetailOptions = { includeWorkflow: true, includeRefinementLoop: true };

function snapshotDetailQueryInput(snapshotId: string, options?: SnapshotDetailOptions) {
    const includeWorkflow = options?.includeWorkflow === true;
    const includeRefinementLoop = options?.includeRefinementLoop === true;
    if (!includeWorkflow && !includeRefinementLoop) return { snapshotId };
    return { snapshotId, includeWorkflow, includeRefinementLoop };
}

export function useSnapshotDetail(snapshotId: string, options?: SnapshotDetailOptions) {
    return useSuspenseQuery({
        ...trpc.branches.snapshotDetail.queryOptions(snapshotDetailQueryInput(snapshotId, options)),
        refetchInterval: (query) => {
            const data = query.state.data;
            if (data == null) return false;
            // An authoritative snapshot has no diffs job; its liveness is polled by the analysis-report/job queries,
            // not this one. With no diffs job there is nothing on this payload to keep watching for.
            const diffsJob = data.diffsJob;
            if (diffsJob == null) return data.refinementLoop?.status === "running" ? 5000 : false;
            const affectedGens = diffsJob.affectedTests.map((t) => t.generation);
            const hasIncompleteGenerations = affectedGens.some(
                (g) => g != null && INCOMPLETE_GENERATION_STATUSES.has(g.status),
            );
            const hasInFlightDiffsJob = !TERMINAL_DIFFS_JOB_STATUSES.has(diffsJob.status);
            const hasInFlightLoop = data.refinementLoop?.status === "running";
            return hasIncompleteGenerations || hasInFlightDiffsJob || hasInFlightLoop ? 5000 : false;
        },
    });
}

export async function ensureSnapshotDetailData(
    queryClient: QueryClient,
    snapshotId: string,
    options?: SnapshotDetailOptions,
) {
    await ensureAPIQueryData(
        queryClient,
        trpc.branches.snapshotDetail.queryOptions(snapshotDetailQueryInput(snapshotId, options)),
    );
}

export function useSnapshotReport(snapshotId: string) {
    return useSuspenseQuery({
        ...trpc.branches.snapshotReport.queryOptions({ snapshotId }),
        refetchInterval: (query) => {
            const data = query.state.data;
            if (data == null) return false;
            return data.results.running > 0 || data.health === "running" ? 5000 : false;
        },
    });
}

export async function ensureSnapshotReportData(queryClient: QueryClient, snapshotId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.snapshotReport.queryOptions({ snapshotId }));
}

export function useActiveSnapshot(branchId: string) {
    return useSuspenseQuery(trpc.branches.activeSnapshot.queryOptions({ branchId }));
}

export async function ensureActiveSnapshotData(queryClient: QueryClient, branchId: string) {
    await ensureAPIQueryData(queryClient, trpc.branches.activeSnapshot.queryOptions({ branchId }));
}
