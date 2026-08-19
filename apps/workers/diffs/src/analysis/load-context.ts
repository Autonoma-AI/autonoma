import { AnalysisStore, PRIOR_REPORTS_LIMIT } from "@autonoma/analysis";
import { db } from "@autonoma/db";
import type { BranchHistory, DiffsAgentInput } from "@autonoma/diffs";
import { FlowIndex, loadFlows, mapTestSuiteToContext } from "@autonoma/diffs";
import type { GitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import type { Suite } from "@autonoma/test-suite";
import { analysisIssueKindSchema } from "@autonoma/types";
import { loadScenarioIndex } from "../load-scenario-index";

/** The metadata pieces of {@link DiffsAgentInput} that load-context produces - everything except the codebase clone. */
export type DiffsAgentMetadata = Omit<DiffsAgentInput, "codebase">;

export interface BranchData {
    applicationId: string;
    organizationId: string;
    repoId: number;
    fullName: string;
    installationId: string;
    /** Repository's default branch (e.g. "main"), fetched from GitHub. Used to filter PRs in merge detection. */
    defaultBranch: string;
    /** True when the snapshot belongs to the application's main branch. Gates the feat/x -> main merge flow. */
    isMainBranch: boolean;
}

export async function loadBranchData(branchId: string, githubApp: GitHubApp): Promise<BranchData> {
    const branch = await db.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: {
            applicationId: true,
            application: {
                select: {
                    organizationId: true,
                    githubRepositoryId: true,
                    mainBranchId: true,
                },
            },
        },
    });

    if (branch.application.githubRepositoryId == null) {
        throw new Error(`No GitHub repository linked to application ${branch.applicationId}`);
    }

    const installation = await db.gitHubInstallation.findUnique({
        where: { organizationId: branch.application.organizationId },
    });

    if (installation == null) {
        throw new Error(`No GitHub installation found for organization ${branch.application.organizationId}`);
    }

    const client = await githubApp.getInstallationClient(installation.installationId);
    const repo = await client.getRepository(branch.application.githubRepositoryId);

    return {
        applicationId: branch.applicationId,
        organizationId: branch.application.organizationId,
        repoId: branch.application.githubRepositoryId,
        fullName: repo.fullName,
        installationId: String(installation.installationId),
        defaultBranch: repo.defaultBranch,
        isMainBranch: branch.application.mainBranchId === branchId,
    };
}

export interface LoadDiffsContextParams {
    applicationId: string;
    suiteInfo: Suite;
    headSha: string;
    baseSha: string;
    branchId: string;
    /** The run's own snapshot: excluded from the prior-report history so a run never reads its own report. */
    snapshotId: string;
}

export async function loadDiffsContext({
    applicationId,
    suiteInfo,
    headSha,
    baseSha,
    branchId,
    snapshotId,
}: LoadDiffsContextParams): Promise<{ metadata: DiffsAgentMetadata }> {
    const { existingTests } = mapTestSuiteToContext(suiteInfo);

    const [flows, application, scenarios, branchHistory] = await Promise.all([
        loadFlows(db, applicationId, suiteInfo),
        db.application.findUniqueOrThrow({
            where: { id: applicationId },
            select: { testScopeGuidelines: true },
        }),
        loadScenarioIndex(db, applicationId),
        loadBranchHistory(branchId, snapshotId),
    ]);
    const flowIndex = new FlowIndex(flows);

    logger.info("Loaded diffs context", {
        extra: {
            existingTests: existingTests.length,
            flows: flows.length,
            scenarios: scenarios.listScenarios().length,
            hasTestScopeGuidelines: application.testScopeGuidelines != null,
            removedTests: branchHistory.removedTests.length,
            priorReports: branchHistory.priorReports.length,
            openIssues: branchHistory.openIssues.length,
        },
    });

    return {
        metadata: {
            headSha,
            baseSha,
            existingTests,
            flowIndex,
            scenarios,
            testScopeGuidelines: application.testScopeGuidelines ?? undefined,
            branchHistory,
        },
    };
}

/**
 * The bounded slice of the branch's analysis history fed to the selector: the tests prior runs removed as
 * `invalid_test`, the branch's recent Reporter reports (excluding this run's own, capped by the Reporter's own
 * bound), and its open bug-kind issues. All three reads are branch-scoped and independent, so they run together.
 */
async function loadBranchHistory(branchId: string, snapshotId: string): Promise<BranchHistory> {
    const ledger = new AnalysisStore(db).forBranch(branchId);
    const [removedTests, priorReports, openIssues] = await Promise.all([
        ledger.removedInvalidTests(),
        ledger.priorReports({ excludeSnapshotId: snapshotId, limit: PRIOR_REPORTS_LIMIT }),
        ledger.openIssues({ kind: analysisIssueKindSchema.enum.bug }),
    ]);

    return {
        removedTests: removedTests.map((t) => ({ slug: t.slug, name: t.name, reason: t.reason })),
        priorReports: priorReports.map((r) => ({ snapshotId: r.snapshotId, report: r.reportMarkdown })),
        openIssues: openIssues.map((issue) => ({
            title: issue.title,
            expectedBehavior: issue.expectedBehavior,
            actualBehavior: issue.actualBehavior,
            coveredSlugs: [...new Set(issue.coveredFindings.map((finding) => finding.slug))],
        })),
    };
}
