import { analytics } from "@autonoma/analytics";
import { createBillingService, type BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import { ScenarioRecipeStore, type EncryptionHelper, type ScenarioManager } from "@autonoma/scenario";
import type { StorageProvider } from "@autonoma/storage";
import type { GenerationProvider } from "@autonoma/test-updates";
import type {
    TriggerPreviewDeployParams,
    TriggerPreviewRedeployAppParams,
    TriggerPreviewTeardownParams,
} from "@autonoma/types";
import type {
    TriggerDiffsJobParams,
    TriggerInvestigationJobParams,
    TriggerRunWorkflowParams,
} from "@autonoma/workflow";
import { ApplicationSetupService } from "../application-setup/application-setup.service";
import type { Auth } from "../auth";
import { DiffsTriggerService } from "../diffs/diffs-trigger.service";
import { env } from "../env";
import { GitHubInstallationService } from "../github/github-installation.service";
import { PullRequestCacheService } from "../github/pull-request-cache.service";
import { RepoIntrospectionService } from "../github/repo-introspection.service";
import { PreviewkitSecretsService } from "../previewkit/previewkit-secrets.service";
import { PreviewkitTriggerService } from "../previewkit/previewkit-trigger.service";
import { AdminService } from "./admin/admin.service";
import { ApiKeysService } from "./api-keys/api-keys.service";
import { ApplicationSetupsService } from "./app-generations/app-generations.service";
import { ApplicationsService } from "./applications/applications.service";
import { AuthService } from "./auth/auth.service";
import { BranchesService } from "./branches/branches.service";
import { BugsService } from "./bugs/bugs.service";
import { DeploymentsService } from "./deployments/deployments.service";
import { PreviewkitEnvFactoryService } from "./deployments/previewkit-env-factory.service";
import { FoldersService } from "./folders/folders.service";
import { IssuesService } from "./issues/issues.service";
import { OnboardingManager } from "./onboarding/onboarding-manager";
import { OnboardingService } from "./onboarding/onboarding.service";
import { OrgSecretsService } from "./org-secrets/org-secrets.service";
import { RunsService } from "./runs/runs.service";
import { ScenariosService } from "./scenarios/scenarios.service";
import { SnapshotEditService } from "./snapshot-edit/snapshot-edit.service";
import { TestGenerationsService } from "./test-generations/test-generations.service";
import { TestsService } from "./tests/tests.service";

export interface Services {
    admin: AdminService;
    auth: AuthService;
    apiKeys: ApiKeysService;
    applications: ApplicationsService;
    branches: BranchesService;
    bugs: BugsService;
    deployments: DeploymentsService;
    previewkitEnvFactory: PreviewkitEnvFactoryService;
    runs: RunsService;
    testGenerations: TestGenerationsService;
    tests: TestsService;
    folders: FoldersService;
    scenarios: ScenariosService;
    secrets: PreviewkitSecretsService;
    orgSecrets: OrgSecretsService;
    github: GitHubInstallationService;
    repoIntrospection: RepoIntrospectionService;
    issues: IssuesService;
    onboarding: OnboardingService;
    snapshotEdit: SnapshotEditService;
    billing: BillingService;
    applicationSetups: ApplicationSetupsService;
    diffsTrigger: DiffsTriggerService;
    previewkitTrigger: PreviewkitTriggerService;
}

export interface ServicesParams {
    conn: PrismaClient;
    auth: Auth;
    storageProvider: StorageProvider;
    triggerRunWorkflow: (params: TriggerRunWorkflowParams) => Promise<void>;
    scenarioManager: ScenarioManager;
    encryptionHelper: EncryptionHelper;
    generationProvider: GenerationProvider;
    githubApp: GitHubApp;
    triggerDiffsJob: (params: TriggerDiffsJobParams) => Promise<void>;
    cancelDiffsJob: (snapshotId: string) => Promise<void>;
    triggerInvestigationJob: (params: TriggerInvestigationJobParams) => Promise<void>;
    triggerPreviewDeploy: (params: TriggerPreviewDeployParams) => Promise<void>;
    triggerPreviewTeardown: (params: TriggerPreviewTeardownParams) => Promise<void>;
    triggerPreviewRedeployApp: (params: TriggerPreviewRedeployAppParams) => Promise<void>;
}

export function buildServices({
    conn,
    auth,
    storageProvider,
    triggerRunWorkflow,
    scenarioManager,
    encryptionHelper,
    generationProvider,
    githubApp,
    triggerDiffsJob,
    cancelDiffsJob,
    triggerInvestigationJob,
    triggerPreviewDeploy,
    triggerPreviewTeardown,
    triggerPreviewRedeployApp,
}: ServicesParams): Services {
    const billingService = createBillingService(conn);
    const previewkitSecretsService = new PreviewkitSecretsService(env.S3_REGION, conn);
    const githubService = new GitHubInstallationService(conn, githubApp);
    const repoIntrospectionService = new RepoIntrospectionService(conn, githubApp);
    const applicationsService = new ApplicationsService(conn, encryptionHelper);
    const previewkitTrigger = new PreviewkitTriggerService(
        conn,
        githubService,
        triggerPreviewDeploy,
        triggerPreviewTeardown,
        triggerPreviewRedeployApp,
    );
    const onboardingManager = new OnboardingManager(conn, scenarioManager, encryptionHelper, {
        previewkitClient: {
            isConfigured: () => env.PREVIEWKIT_ENABLED,
            deployApplicationMain: async (applicationId, organizationId) => {
                await previewkitTrigger.deployMainBranch(applicationId, organizationId);
            },
            redeploy: async (repoFullName, prNumber, organizationId) => {
                await previewkitTrigger.redeploy(repoFullName, prNumber, organizationId);
            },
        },
        previewkitSecretsService,
        repoIntrospection: repoIntrospectionService,
        github: githubService,
        applications: applicationsService,
    });
    const prCacheService = new PullRequestCacheService(conn, githubService);
    const apiKeysService = new ApiKeysService(conn);
    const applicationSetupService = new ApplicationSetupService(
        conn,
        generationProvider,
        onboardingManager,
        new ScenarioRecipeStore(conn),
    );

    return {
        admin: new AdminService(conn, auth, githubApp),
        auth: new AuthService(conn),
        apiKeys: apiKeysService,
        branches: new BranchesService(conn, githubService, storageProvider, prCacheService),
        bugs: new BugsService(conn, storageProvider, analytics, env.APP_URL),
        deployments: new DeploymentsService(conn, previewkitTrigger),
        previewkitEnvFactory: new PreviewkitEnvFactoryService(conn, encryptionHelper),
        applications: applicationsService,
        runs: new RunsService(conn, storageProvider, triggerRunWorkflow, billingService),
        testGenerations: new TestGenerationsService(conn, storageProvider, billingService),
        tests: new TestsService(conn, storageProvider),
        folders: new FoldersService(conn),
        scenarios: new ScenariosService(conn, scenarioManager),
        secrets: new PreviewkitSecretsService(env.S3_REGION, conn),
        orgSecrets: new OrgSecretsService(conn, env.AWS_REGION ?? "us-east-1"),
        github: githubService,
        repoIntrospection: repoIntrospectionService,
        issues: new IssuesService(conn, storageProvider),
        onboarding: new OnboardingService(onboardingManager),
        snapshotEdit: new SnapshotEditService(conn, generationProvider, billingService, storageProvider),
        billing: billingService,
        applicationSetups: new ApplicationSetupsService(conn, applicationSetupService, apiKeysService),
        diffsTrigger: new DiffsTriggerService(
            conn,
            githubService,
            triggerDiffsJob,
            cancelDiffsJob,
            triggerInvestigationJob,
        ),
        previewkitTrigger,
    };
}
