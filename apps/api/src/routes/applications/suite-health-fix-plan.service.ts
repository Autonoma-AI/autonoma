import { AnalysisStore } from "@autonoma/analysis";
import type { PrismaClient } from "@autonoma/db";
import type {
    SuiteHealthFixBranch,
    SuiteHealthFixCluster,
    SuiteHealthFixBranchState,
    SuiteHealthFixIssue,
    SuiteHealthFixKind,
    SuiteHealthFixPlan,
    SuiteHealthFixSeverity,
    SuiteHealthLevel,
} from "@autonoma/types";
import { suiteHealthFixBranchStateSchema } from "@autonoma/types";
import { findApplicationRepo } from "../../github/application-repo";
import type { GitHubInstallationService } from "../../github/github-installation.service";
import { Service } from "../service";
import { suiteHealthFixPrompt } from "./suite-health-fix-prompt";
import type { SuiteHealthService } from "./suite-health.service";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How far back a merged or closed pull request still counts as "recently failed". */
const RECENT_WINDOW_DAYS = 30;

/** Findings listed per branch in the prompt's per-branch detail. The counts always report the full total. */
const MAX_ISSUES_PER_BRANCH = 4;

/** Worst first, so the modal and the prompt both lead with what matters. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * The verdicts that map onto a fix the user's agent can actually make, and the kind each becomes. Deliberately
 * excludes `plan_mismatch` and `engine_artifact`: both are real failures, but one is our harness and the other is
 * a test the healing loop already owns - neither belongs on a list titled "here is what to go fix".
 */
const VERDICT_TO_KIND: Record<string, SuiteHealthFixKind | undefined> = {
    client_bug: "bug",
    environment_failure: "environment",
    scenario_issue: "scenario",
};
const ACTIONABLE_VERDICTS = Object.keys(VERDICT_TO_KIND);

/**
 * Repeated findings surfaced to the agent, and the minimum branch span before a repeat is worth naming.
 */
const MAX_CLUSTERS = 5;
const MIN_CLUSTER_BRANCHES = 2;

/**
 * Cap on how many unresolved findings either scan will read. Both paths need it, not just the fallback: a
 * fully-broken app produces hundreds of near-identical findings, and an app with many live pull requests has an
 * unbounded number of open issues. Hitting it sets `truncated`, so the count is reported as a floor.
 */
const MAX_SCANNED_ISSUES = 200;

interface IssueRow {
    id: string;
    // The store validated both enums at its read boundary; the two producers below only ever put a valid value here.
    kind: SuiteHealthFixKind;
    severity: SuiteHealthFixSeverity;
    title: string;
    createdAt: Date;
    branchId: string;
    branch: {
        name: string;
        prInfo: { prNumber: number; prTitle: string | null; prState: string | null } | null;
        mainOfApplication: { id: string } | null;
    };
}

/**
 * Assembles the "put the suite back in order" plan: every unresolved finding on an application, grouped by the
 * branch it sits on, plus a prompt that hands the whole backlog to a coding agent holding the Autonoma MCP.
 *
 * The point is a single agent pass that clears enough of the list to put the suite back to CALIBRATING. That only
 * works if the agent is told WHERE each fix lives - a bug is a code change, an environment failure is a secret or
 * config change, a scenario issue is a recipe change - which is why the plan carries `kind` all the way through.
 */
export class SuiteHealthFixPlanService extends Service {
    private readonly analysisStore: AnalysisStore;

    constructor(
        private readonly db: PrismaClient,
        private readonly github: GitHubInstallationService,
        private readonly suiteHealth: SuiteHealthService,
    ) {
        super();
        this.analysisStore = new AnalysisStore(db);
    }

    async getForApplication(applicationId: string, organizationId: string): Promise<SuiteHealthFixPlan> {
        this.logger.info("Building suite-health fix plan", {
            application: { applicationId },
            organization: { organizationId },
        });

        // The level is read from the same service the meter reads, never passed in by the caller: the prompt
        // opens by stating it, and a prompt that disagrees with the sidebar is worse than one that omits it.
        const [health, reported, repoFullName] = await Promise.all([
            this.suiteHealth.getForApplication(applicationId, organizationId),
            this.openIssues(applicationId, organizationId),
            findApplicationRepo(
                { db: this.db, listRepositories: (orgId) => this.github.listRepositories(orgId) },
                organizationId,
                applicationId,
            ).then((repo) => repo?.fullName),
        ]);
        const level: SuiteHealthLevel = health.level;

        // An app can be DEGRADED with no issues at all: the Reporter authors issues only after a run gets far
        // enough to reconcile, so a suite whose every run dies in provisioning has 100% failing findings and an
        // empty issue table. That is the app that needs this modal most, so fall back to the raw findings.
        const issues = reported.length > 0 ? reported : await this.failingFindings(applicationId, organizationId);

        const now = new Date();
        const branches = groupByBranch(issues, now, repoFullName);

        const openPullRequests = branches.filter((branch) => branch.state === "open");
        // Main sits with the closed pull requests rather than in its own group: what unites them is that no one is
        // going to look at these again on their own, which is exactly why they need naming.
        const recentlyFailed = branches.filter((branch) => branch.state !== "open");

        const clusters = clusterByTitle(issues);
        const byKind = tallyKinds(issues);
        const oldestAgeDays = issues.reduce(
            (oldest, issue) => Math.max(oldest, wholeDaysBetween(issue.createdAt, now)),
            0,
        );

        // Both scans are capped, so a badly-broken app reports a floor rather than a count. Say so everywhere it
        // is shown - a silent cap reads as "this is all of it".
        const truncated = issues.length >= MAX_SCANNED_ISSUES;

        const prompt = suiteHealthFixPrompt({
            level,
            repoFullName,
            openPullRequests,
            recentlyFailed,
            totalIssues: issues.length,
            byKind,
            oldestAgeDays,
            truncated,
            clusters,
        });

        this.logger.info("Built suite-health fix plan", {
            application: { applicationId },
            extra: {
                totalIssues: issues.length,
                openPullRequests: openPullRequests.length,
                recentlyFailed: recentlyFailed.length,
                clusters: clusters.length,
                repoResolved: repoFullName != null,
            },
        });

        return {
            repoFullName,
            totalIssues: issues.length,
            byKind,
            oldestAgeDays,
            truncated,
            clusters,
            prompt,
        };
    }

    /**
     * Every open finding on the app: on a live pull request, on main, or on a pull request that merged or closed
     * inside the recent window without anyone clearing it. The issue facts come from the analysis store; the
     * branch presentation (names, PR titles) is joined here, where it belongs.
     */
    private async openIssues(applicationId: string, organizationId: string): Promise<IssueRow[]> {
        const since = new Date(Date.now() - RECENT_WINDOW_DAYS * MS_PER_DAY);

        const issues = await this.analysisStore
            .forApplication(applicationId, organizationId)
            .openIssuesOnLiveSurfaces({ recentSince: since, limit: MAX_SCANNED_ISSUES });
        const branches = await this.loadBranchDisplay(issues.map((issue) => issue.branchId));

        return issues.flatMap((issue) => {
            const branch = branches.get(issue.branchId);
            if (branch == null) return [];
            return [
                {
                    id: issue.id,
                    kind: issue.kind,
                    severity: issue.severity,
                    title: issue.title,
                    createdAt: issue.createdAt,
                    branchId: issue.branchId,
                    branch,
                },
            ];
        });
    }

    private async loadBranchDisplay(branchIds: string[]): Promise<Map<string, IssueRow["branch"]>> {
        if (branchIds.length === 0) return new Map();
        const branches = await this.db.branch.findMany({
            where: { id: { in: [...new Set(branchIds)] } },
            select: {
                id: true,
                name: true,
                prInfo: { select: { prNumber: true, prTitle: true, prState: true } },
                mainOfApplication: { select: { id: true } },
            },
        });
        return new Map(
            branches.map((branch) => [
                branch.id,
                { name: branch.name, prInfo: branch.prInfo, mainOfApplication: branch.mainOfApplication },
            ]),
        );
    }

    /**
     * The last runs' failing findings, shaped like issues, for an app whose runs never reach the Reporter. Only
     * the three MCP-actionable verdicts are included: an `engine_artifact` or `plan_mismatch` is real, but neither
     * is something the user's agent can go fix, and listing them would send somebody chasing our harness.
     */
    private async failingFindings(applicationId: string, organizationId: string): Promise<IssueRow[]> {
        const since = new Date(Date.now() - RECENT_WINDOW_DAYS * MS_PER_DAY);

        const findings = await this.analysisStore
            .forApplication(applicationId, organizationId)
            .recentFindings({ since, categories: ACTIONABLE_VERDICTS, limit: MAX_SCANNED_ISSUES });
        const branches = await this.loadBranchDisplay(findings.map((finding) => finding.branchId));

        this.logger.info("No reported issues; falling back to failing findings", {
            application: { applicationId },
            extra: { findings: findings.length },
        });

        return findings.flatMap((finding) => {
            const branch = branches.get(finding.branchId);
            if (branch == null) return [];
            return [
                {
                    id: finding.findingId,
                    kind: VERDICT_TO_KIND[finding.category ?? ""] ?? "bug",
                    // Findings carry no severity of their own; they all read as one failing run needing a look.
                    severity: "medium",
                    title: finding.headline ?? "Run did not reach a verdict",
                    createdAt: finding.createdAt,
                    branchId: finding.branchId,
                    branch,
                },
            ];
        });
    }
}

function groupByBranch(issues: IssueRow[], now: Date, repoFullName: string | undefined): SuiteHealthFixBranch[] {
    const byBranch = new Map<string, IssueRow[]>();
    for (const issue of issues) {
        const existing = byBranch.get(issue.branchId);
        if (existing == null) byBranch.set(issue.branchId, [issue]);
        else existing.push(issue);
    }

    const branches = [...byBranch.values()].map((rows) => toBranch(rows, now, repoFullName));
    // Most findings first, NOT oldest first. The agent is told to start with the open pull requests and to fix
    // shared causes once, so the useful lead is the branch carrying the most - age says nothing about leverage,
    // and the oldest branch is often a closed one nobody is waiting on.
    return branches.sort((a, b) => b.issueCount - a.issueCount);
}

function toBranch(rows: IssueRow[], now: Date, repoFullName: string | undefined): SuiteHealthFixBranch {
    // Every row in the group shares a branch, so the first carries the branch facts for all of them.
    const first = rows[0];
    if (first == null) throw new Error("groupByBranch produced an empty branch group");

    const sorted = [...rows].sort(bySeverityThenAge);
    const prNumber = first.branch.prInfo?.prNumber;

    return {
        branchId: first.branchId,
        branchName: first.branch.name,
        state: branchState(first),
        prNumber,
        prTitle: first.branch.prInfo?.prTitle ?? undefined,
        prUrl:
            repoFullName != null && prNumber != null
                ? `https://github.com/${repoFullName}/pull/${prNumber}`
                : undefined,
        issues: sorted.slice(0, MAX_ISSUES_PER_BRANCH).map((row) => toIssue(row, now)),
        issueCount: rows.length,
        byKind: tallyKinds(rows),
        oldestAgeDays: rows.reduce((oldest, row) => Math.max(oldest, wholeDaysBetween(row.createdAt, now)), 0),
    };
}

function branchState(row: IssueRow): SuiteHealthFixBranchState {
    if (row.branch.mainOfApplication != null) return "main";

    const parsed = suiteHealthFixBranchStateSchema.safeParse(row.branch.prInfo?.prState);
    // An un-cached PR state (the GitHub backfill is lazy) reads as still open, which is the state that keeps it
    // in front of the user rather than quietly filing it under "already gone".
    return parsed.success ? parsed.data : "open";
}

function toIssue(row: IssueRow, now: Date): SuiteHealthFixIssue {
    return {
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        ageDays: wholeDaysBetween(row.createdAt, now),
    };
}

function bySeverityThenAge(a: IssueRow, b: IssueRow): number {
    const bySeverity = (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
    if (bySeverity !== 0) return bySeverity;
    return a.createdAt.getTime() - b.createdAt.getTime();
}

function tallyKinds(issues: IssueRow[]): Record<SuiteHealthFixKind, number> {
    const byKind: Record<SuiteHealthFixKind, number> = { bug: 0, environment: 0, scenario: 0 };
    for (const issue of issues) byKind[issue.kind] += 1;
    return byKind;
}

function wholeDaysBetween(from: Date, to: Date): number {
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/**
 * Groups findings that share a title across branches - one cause showing up everywhere. Matches on the exact
 * (normalised) title only: a fuzzy match would invent relationships between genuinely different failures, and a
 * wrong "fix this once and 12 PRs clear" is worse than no hint at all.
 */
function clusterByTitle(issues: IssueRow[]): SuiteHealthFixCluster[] {
    const groups = new Map<string, IssueRow[]>();
    for (const issue of issues) {
        const key = issue.title.trim().toLowerCase().replace(/\s+/g, " ");
        const existing = groups.get(key);
        if (existing == null) groups.set(key, [issue]);
        else existing.push(issue);
    }

    const clusters: SuiteHealthFixCluster[] = [];
    for (const rows of groups.values()) {
        const branches = new Set(rows.map((row) => row.branchId));
        if (branches.size < MIN_CLUSTER_BRANCHES) continue;

        const openBranchIds = new Set(rows.filter((row) => branchState(row) === "open").map((row) => row.branchId));
        const first = rows[0];
        if (first == null) continue;

        clusters.push({
            title: first.title,
            kind: first.kind,
            branches: branches.size,
            openBranches: openBranchIds.size,
            findings: rows.length,
        });
    }

    return clusters.sort((a, b) => b.branches - a.branches || b.findings - a.findings).slice(0, MAX_CLUSTERS);
}
