import type { EncryptionHelper } from "@autonoma/scenario";
import type { SecretItem, SecretSummary } from "@autonoma/types";

export interface PreviewkitSecretsUpsertResult {
    created: boolean;
    changed: boolean;
}

export interface OnboardingPreviewkitClient {
    deployApplicationMain(applicationId: string, organizationId: string): Promise<void>;
    redeploy(repoFullName: string, prNumber: number, organizationId: string): Promise<void>;
    /** First deploy for an open PR with no preview environment yet (e.g. a draft the webhook skipped). */
    startRunForPullRequest(organizationId: string, githubRepositoryId: number, prNumber: number): Promise<void>;
}

export interface OnboardingPreviewkitSecretsService {
    list(applicationId: string, appName: string, callerOrgId: string | undefined): Promise<SecretSummary[]>;
    upsert(
        applicationId: string,
        appName: string,
        items: SecretItem[],
        callerOrgId: string | undefined,
    ): Promise<PreviewkitSecretsUpsertResult | void>;
    delete(applicationId: string, appName: string, key: string, callerOrgId: string | undefined): Promise<boolean>;
    getValue?(
        applicationId: string,
        appName: string,
        key: string,
        callerOrgId: string | undefined,
    ): Promise<string | undefined>;
}

export interface OnboardingRepoIntrospection {
    /** Returns the repo's file tree at its default branch head, or undefined when unavailable. */
    getRepoTree(
        organizationId: string,
        applicationId: string,
        githubRepositoryId?: number,
    ): Promise<{ paths: string[]; truncated: boolean } | undefined>;
}

export interface OnboardingGithubRepository {
    id: number;
    name: string;
    fullName: string;
    defaultBranch: string;
}

export interface OnboardingGithubService {
    /** The org installation's repos, or `unavailable` when GitHub could not be read (never a silently short list). */
    listRepositories(orgId: string): Promise<{ repos: OnboardingGithubRepository[]; unavailable?: string }>;
    linkRepository(orgId: string, applicationId: string, githubRepoId: number): Promise<void>;
    /** Resolves a branch's head SHA; used to validate a chosen deploy branch exists. Rejects (404) when it doesn't. */
    getBranchHead(orgId: string, repoId: number, branchName: string): Promise<string>;
    /** The repo's branch names + default branch, for the deploy-branch picker. `truncated` = more branches than one page. */
    listApplicationBranches(
        orgId: string,
        applicationId: string,
    ): Promise<{ names: string[]; defaultBranch: string; truncated: boolean }>;
}

export interface OnboardingApplicationsService {
    createMinimalApplication(name: string, organizationId: string): Promise<{ id: string }>;
}

/**
 * The diff-trigger fan-out for the BYO path: a single `deployment_status` signal
 * both records the preview URL and triggers diff analysis from the URL it
 * carries (no second call). Structurally satisfied by `DiffsTriggerService`.
 */
export interface OnboardingDiffsTrigger {
    triggerMainDiffs(params: {
        organizationId: string;
        repoId: number;
        url: string;
        webhookUrl?: string;
    }): Promise<{ snapshotId?: string; skipped?: boolean }>;
    triggerPrDiffs(params: {
        organizationId: string;
        repoId: number;
        prNumber: number;
        url: string;
        webhookUrl?: string;
    }): Promise<{ snapshotId?: string; skipped?: boolean }>;
}

export interface OnboardingManagerOptions {
    previewkitClient?: OnboardingPreviewkitClient;
    previewkitSecretsService?: OnboardingPreviewkitSecretsService;
    repoIntrospection?: OnboardingRepoIntrospection;
    github?: OnboardingGithubService;
    applications?: OnboardingApplicationsService;
    diffsTrigger?: OnboardingDiffsTrigger;
    /** Lazily constructed - VERCEL_ENCRYPTION_KEY is optional, unlike the primary scenario encryption key. */
    getVercelEncryptionHelper?: () => EncryptionHelper;
}
