import type { SecretItem, SecretSummary } from "@autonoma/types";

export interface OnboardingPreviewkitClient {
    isConfigured(): boolean;
    deployApplicationMain(applicationId: string, organizationId: string): Promise<void>;
}

export interface OnboardingPreviewkitSecretsService {
    list(applicationId: string, appName: string, callerOrgId: string | undefined): Promise<SecretSummary[]>;
    upsert(applicationId: string, appName: string, items: SecretItem[], callerOrgId: string | undefined): Promise<void>;
    delete(applicationId: string, appName: string, key: string, callerOrgId: string | undefined): Promise<boolean>;
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

export interface OnboardingManagerOptions {
    previewkitClient?: OnboardingPreviewkitClient;
    previewkitSecretsService?: OnboardingPreviewkitSecretsService;
    repoIntrospection?: OnboardingRepoIntrospection;
    github?: OnboardingGithubService;
    applications?: OnboardingApplicationsService;
}
