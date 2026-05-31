import { analytics } from "@autonoma/analytics";
import { createBillingService, type BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import type { StorageProvider } from "@autonoma/storage";
import type { GenerationProvider } from "@autonoma/test-updates";
import type { TriggerDiffsJobParams, TriggerRunWorkflowParams } from "@autonoma/workflow";
import type { Auth } from "../auth";
import { DiffsTriggerService } from "../diffs/diffs-trigger.service";
import { env } from "../env";
import { GitHubInstallationService } from "../github/github-installation.service";
import { AdminService } from "./admin/admin.service";
import { ApiKeysService } from "./api-keys/api-keys.service";
import { ApplicationSetupsService } from "./app-generations/app-generations.service";
import { ApplicationsService } from "./applications/applications.service";
import { AuthService } from "./auth/auth.service";
import { BranchesService } from "./branches/branches.service";
import { BugsService } from "./bugs/bugs.service";
import { DeploymentsService } from "./deployments/deployments.service";
import { FoldersService } from "./folders/folders.service";
import { IssuesService } from "./issues/issues.service";
import { OnboardingManager } from "./onboarding/onboarding-manager";
import { OnboardingService } from "./onboarding/onboarding.service";
import { OrgSecretsService } from "./org-secrets/org-secrets.service";
import { RunsService } from "./runs/runs.service";
import { ScenariosService } from "./scenarios/scenarios.service";
import { SecretsService } from "./secrets/secrets.service";
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
    runs: RunsService;
    testGenerations: TestGenerationsService;
    tests: TestsService;
    folders: FoldersService;
    scenarios: ScenariosService;
    secrets: SecretsService;
    orgSecrets: OrgSecretsService;
    github: GitHubInstallationService;
    issues: IssuesService;
    onboarding: OnboardingService;
    snapshotEdit: SnapshotEditService;
    billing: BillingService;
    applicationSetups: ApplicationSetupsService;
    diffsTrigger: DiffsTriggerService;
}

export type TriggerGenerationReview = (generationId: string) => void | Promise<void>;
export type TriggerRunReview = (runId: string) => void | Promise<void>;

export interface ServicesParams {
    conn: PrismaClient;
    auth: Auth;
    storageProvider: StorageProvider;
    triggerRunWorkflow: (params: TriggerRunWorkflowParams) => Promise<void>;
    triggerGenerationReview: TriggerGenerationReview;
    triggerRunReview: TriggerRunReview;
    scenarioManager: ScenarioManager;
    encryptionHelper: EncryptionHelper;
    generationProvider: GenerationProvider;
    githubApp: GitHubApp;
    triggerDiffsJob: (params: TriggerDiffsJobParams) => Promise<void>;
    cancelDiffsJob: (snapshotId: string) => Promise<void>;
}

export function buildServices({
    conn,
    auth,
    storageProvider,
    triggerRunWorkflow,
    triggerGenerationReview,
    triggerRunReview,
    scenarioManager,
    encryptionHelper,
    generationProvider,
    githubApp,
    triggerDiffsJob,
    cancelDiffsJob,
}: ServicesParams): Services {
    const billingService = createBillingService(conn);
    const onboardingManager = new OnboardingManager(conn, scenarioManager, encryptionHelper);
    const githubService = new GitHubInstallationService(conn, githubApp);

    return {
        admin: new AdminService(conn, auth, githubApp),
        auth: new AuthService(conn),
        apiKeys: new ApiKeysService(conn),
        branches: new BranchesService(conn),
        bugs: new BugsService(conn, storageProvider, analytics, env.APP_URL),
        deployments: new DeploymentsService(conn),
        applications: new ApplicationsService(conn, encryptionHelper),
        runs: new RunsService(conn, storageProvider, triggerRunWorkflow, billingService),
        testGenerations: new TestGenerationsService(conn, storageProvider, billingService),
        tests: new TestsService(conn, storageProvider),
        folders: new FoldersService(conn),
        scenarios: new ScenariosService(conn, scenarioManager),
        secrets: new SecretsService(conn, env.AWS_REGION ?? "us-east-1"),
        orgSecrets: new OrgSecretsService(conn, env.AWS_REGION ?? "us-east-1"),
        github: githubService,
        issues: new IssuesService(conn, storageProvider, triggerGenerationReview, triggerRunReview),
        onboarding: new OnboardingService(onboardingManager),
        snapshotEdit: new SnapshotEditService(conn, generationProvider, billingService),
        billing: billingService,
        applicationSetups: new ApplicationSetupsService(conn),
        diffsTrigger: new DiffsTriggerService(conn, githubService, triggerDiffsJob, cancelDiffsJob),
    };
}
