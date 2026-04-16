import { db } from "@autonoma/db";
import type { DiffsAgentInput, ExistingSkillInfo, ExistingTestInfo } from "@autonoma/diffs";
import { FlowIndex, type FlowInfo, TestDirectory } from "@autonoma/diffs";
import type { GitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import type { TestSuiteInfo } from "@autonoma/test-updates";

export interface BranchData {
    applicationId: string;
    organizationId: string;
    repoId: number;
    fullName: string;
    installationId: string;
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
    };
}

function mapTestSuiteToContext(suiteInfo: TestSuiteInfo): {
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
} {
    const existingTests: ExistingTestInfo[] = [];
    for (const testCase of suiteInfo.testCases) {
        if (testCase.plan == null) continue;
        existingTests.push({
            id: testCase.id,
            name: testCase.name,
            slug: testCase.slug,
            prompt: testCase.plan.prompt,
        });
    }

    const existingSkills: ExistingSkillInfo[] = [];
    for (const skill of suiteInfo.skills) {
        if (skill.plan == null) continue;
        existingSkills.push({
            id: skill.id,
            name: skill.name,
            slug: skill.slug,
            description: skill.description,
            content: skill.plan.content,
        });
    }

    return { existingTests, existingSkills };
}

export async function loadFlows(applicationId: string, suiteInfo: TestSuiteInfo): Promise<FlowInfo[]> {
    const folders = await db.folder.findMany({
        where: { applicationId },
        select: { id: true, name: true, description: true },
    });

    const testSlugsByFolderId = new Map<string, string[]>();
    for (const testCase of suiteInfo.testCases) {
        if (testCase.plan == null || testCase.folderId == null) continue;
        const slugs = testSlugsByFolderId.get(testCase.folderId);
        if (slugs != null) {
            slugs.push(testCase.slug);
        } else {
            testSlugsByFolderId.set(testCase.folderId, [testCase.slug]);
        }
    }

    return folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        description: folder.description ?? undefined,
        testSlugs: testSlugsByFolderId.get(folder.id) ?? [],
    }));
}

export async function loadDiffsContext(
    applicationId: string,
    suiteInfo: TestSuiteInfo,
    repoDir: string,
    headSha: string,
    baseSha: string,
): Promise<{ input: DiffsAgentInput; testDirectory: TestDirectory; flowIndex: FlowIndex }> {
    const { existingTests, existingSkills } = mapTestSuiteToContext(suiteInfo);

    const [testDirectory, flows] = await Promise.all([
        TestDirectory.create({ workingDirectory: repoDir, tests: existingTests, skills: existingSkills }),
        loadFlows(applicationId, suiteInfo),
    ]);

    const flowIndex = new FlowIndex(flows);

    logger.info("Loaded diffs context", {
        existingTests: existingTests.length,
        existingSkills: existingSkills.length,
        flows: flows.length,
    });

    return {
        input: { headSha, baseSha, existingTests, existingSkills },
        testDirectory,
        flowIndex,
    };
}
