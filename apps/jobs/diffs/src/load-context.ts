import { db } from "@autonoma/db";
import type { DiffsAgentInput } from "@autonoma/diffs";
import { FlowIndex, loadFlows, mapTestSuiteToContext } from "@autonoma/diffs";
import type { GitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import type { TestSuiteInfo } from "@autonoma/test-updates";

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

export async function loadDiffsContext(
    applicationId: string,
    suiteInfo: TestSuiteInfo,
    headSha: string,
    baseSha: string,
): Promise<{ metadata: DiffsAgentMetadata }> {
    const { existingTests } = mapTestSuiteToContext(suiteInfo);

    const [flows, application] = await Promise.all([
        loadFlows(db, applicationId, suiteInfo),
        db.application.findUniqueOrThrow({
            where: { id: applicationId },
            select: { testScopeGuidelines: true },
        }),
    ]);
    const flowIndex = new FlowIndex(flows);

    logger.info("Loaded diffs context", {
        extra: {
            existingTests: existingTests.length,
            flows: flows.length,
            quarantinedTests: existingTests.filter((t) => t.quarantine != null).length,
            hasTestScopeGuidelines: application.testScopeGuidelines != null,
        },
    });

    return {
        metadata: {
            headSha,
            baseSha,
            existingTests,
            flowIndex,
            testScopeGuidelines: application.testScopeGuidelines ?? undefined,
        },
    };
}
