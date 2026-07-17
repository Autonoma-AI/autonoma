import type { EncryptionHelper } from "@autonoma/scenario";
import type { SecretItem, SecretSummary } from "@autonoma/types";

export interface PreviewkitSecretsUpsertResult {
    created: boolean;
    changed: boolean;
}

export interface OnboardingPreviewkitClient {
    isConfigured(): boolean;
    deployApplicationMain(applicationId: string, organizationId: string): Promise<void>;
    redeploy(repoFullName: string, prNumber: number, organizationId: string): Promise<void>;
    /** First deploy for an open PR with no preview environment yet (e.g. a draft the webhook skipped). */
    deployPullRequest(organizationId: string, githubRepositoryId: number, prNumber: number): Promise<void>;
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
    listRepositories(orgId: string): Promise<OnboardingGithubRepository[]>;
    linkRepository(orgId: string, applicationId: string, githubRepoId: number): Promise<void>;
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
    /**
     * Recover investigation comments dropped by the onboarding gate: re-run a fresh investigation for every
     * open PR that never received an investigation comment, so it posts now that onboarding is complete.
     */
    reinvestigateOpenPrs(applicationId: string, organizationId: string): Promise<void>;
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
