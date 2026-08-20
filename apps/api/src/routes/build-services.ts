import { analytics } from "@autonoma/analytics";
import { createBillingService, type BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import { LokiLogStore } from "@autonoma/logger/loki-log-store";
import { ScenarioRecipeStore, type EncryptionHelper, type ScenarioManager } from "@autonoma/scenario";
import type { StorageProvider } from "@autonoma/storage";
import type { TriggerPreviewRedeployAppParams, PreviewTeardownTarget } from "@autonoma/types";
import type {
    AnalysisRunWorkflowInput,
    PreviewBuildWorkflowInput,
    TriggerBatchGenerationParams,
    WorkflowRef,
} from "@autonoma/workflow";
import type Redis from "ioredis";
import { ApplicationSetupService } from "../application-setup/application-setup.service";
import type { Auth } from "../auth";
import { DemoEntrySourceStore } from "../demo/demo-entry-source.store";
import { ParkedSessionStore } from "../demo/parked-session.store";
import { DiffsTriggerService } from "../diffs/diffs-trigger.service";
import { type EmailSender, buildEmailSender } from "../email/email-sender";
import { env } from "../env";
import { ActivationTriggerConfigService } from "../github/activation-trigger-config.service";
import { BranchContributorService } from "../github/branch-contributor.service";
import { BugFixOutcomeService } from "../github/bug-fix-outcome.service";
import { FalsePositiveCandidateService } from "../github/false-positive-candidate.service";
import { GitHubInstallationService } from "../github/github-installation.service";
import { MergeGateSlackNotifier } from "../github/merge-gate-slack-notifier";
import { MergeGateService } from "../github/merge-gate.service";
import { PullRequestCacheService } from "../github/pull-request-cache.service";
import { RepoIntrospectionService } from "../github/repo-introspection.service";
import { RepoReader } from "../github/repo-reader";
import { PreviewkitDiagnosisService } from "../previewkit/previewkit-diagnosis.service";
import { PreviewkitEnvironmentsService } from "../previewkit/previewkit-environments.service";
import { PreviewkitLogsService } from "../previewkit/previewkit-logs.service";
import { PreviewkitOperationsService } from "../previewkit/previewkit-operations.service";
import { PreviewkitSecretStatusService } from "../previewkit/previewkit-secret-status.service";
import { PreviewkitSecretsService } from "../previewkit/previewkit-secrets.service";
import { PreviewkitTriggerService } from "../previewkit/previewkit-trigger.service";
import { PreviewkitWriteService } from "../previewkit/previewkit-write.service";
import { buildSecretKeys, buildSecretValues } from "../previewkit/secret-store";
import { RateLimiterService } from "../rate-limit/rate-limiter.service";
import { AdminService } from "./admin/admin.service";
import { ApiKeysService } from "./api-keys/api-keys.service";
import { ApplicationSetupsService } from "./app-generations/app-generations.service";
import { ApplicationActivityService } from "./applications/application-activity.service";
import { ApplicationsService } from "./applications/applications.service";
import { SuiteHealthFixPlanService } from "./applications/suite-health-fix-plan.service";
import { SuiteHealthService } from "./applications/suite-health.service";
import { AuthService } from "./auth/auth.service";
import { BranchesService } from "./branches/branches.service";
import { DeploymentsService } from "./deployments/deployments.service";
import { PreviewkitEnvFactoryService } from "./deployments/previewkit-env-factory.service";
import { FoldersService } from "./folders/folders.service";
import { OnboardingAgentSessionService } from "./onboarding/onboarding-agent-session.service";
import { OnboardingAnalytics } from "./onboarding/onboarding-analytics";
import { OnboardingManager } from "./onboarding/onboarding-manager";
import { OnboardingService } from "./onboarding/onboarding.service";
import { PreviewkitConfigService } from "./onboarding/previewkit-config-service";
import { OrganizationService } from "./organization/organization.service";
import { ScenariosService } from "./scenarios/scenarios.service";
import { SnapshotEditService } from "./snapshot-edit/snapshot-edit.service";
import { TestGenerationsService } from "./test-generations/test-generations.service";
import { TestsService } from "./tests/tests.service";
import { UsageService } from "./usage/usage.service";

export interface Services {
    admin: AdminService;
    auth: AuthService;
    apiKeys: ApiKeysService;
    applications: ApplicationsService;
    applicationActivity: ApplicationActivityService;
    suiteHealth: SuiteHealthService;
    suiteHealthFixPlan: SuiteHealthFixPlanService;
    branches: BranchesService;
    deployments: DeploymentsService;
    previewkitEnvFactory: PreviewkitEnvFactoryService;
    testGenerations: TestGenerationsService;
    tests: TestsService;
    folders: FoldersService;
    scenarios: ScenariosService;
    secrets: PreviewkitSecretsService;
    previewkitOperations: PreviewkitOperationsService;
    previewkitSecretStatus: PreviewkitSecretStatusService;
    previewkitLogs: PreviewkitLogsService;
    github: GitHubInstallationService;
    falsePositiveCandidates: FalsePositiveCandidateService;
    mergeGate: MergeGateService;
    activationTriggerConfig: ActivationTriggerConfigService;
    branchContributor: BranchContributorService;
    bugFixOutcome: BugFixOutcomeService;
    repoIntrospection: RepoIntrospectionService;
    previewkitDiagnosis: PreviewkitDiagnosisService;
    onboarding: OnboardingService;
    organization: OrganizationService;
    snapshotEdit: SnapshotEditService;
    billing: BillingService;
    applicationSetups: ApplicationSetupsService;
    diffsTrigger: DiffsTriggerService;
    previewkitTrigger: PreviewkitTriggerService;
    previewkitWrite: PreviewkitWriteService;
    previewkitEnvironments: PreviewkitEnvironmentsService;
    rateLimiter: RateLimiterService;
    onboardingAgentSession: OnboardingAgentSessionService;
    onboardingAnalytics: OnboardingAnalytics;
    usage: UsageService;
    getVercelEncryptionHelper: () => EncryptionHelper;
}

export interface ServicesParams {
    conn: PrismaClient;
    auth: Auth;
    redisClient: Redis;
    storageProvider: StorageProvider;
    scenarioManager: ScenarioManager;
    encryptionHelper: EncryptionHelper;
    getVercelEncryptionHelper: () => EncryptionHelper;
    githubApp: GitHubApp;
    /** Required, not optional: production and tests must exercise the same seam. */
    /** Returns the Temporal workflow id, so a deploy request can name what it queued. */
    startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<string>;
    startGenerationBatch: (params: TriggerBatchGenerationParams) => Promise<WorkflowRef>;
    startPreviewBuild: (input: PreviewBuildWorkflowInput) => Promise<void>;
    triggerPreviewTeardown: (target: PreviewTeardownTarget) => Promise<void>;
    triggerPreviewRedeployApp: (params: TriggerPreviewRedeployAppParams) => Promise<void>;
    /**
     * Overrides the transactional email provider. Left unset in production, where it is built
     * from `RESEND_API_KEY`; tests inject a recorder so a send can be observed or made to fail.
     */
    emailSender?: EmailSender;
}

export function buildServices({
    conn,
    auth,
    redisClient,
    storageProvider,
    scenarioManager,
    encryptionHelper,
    getVercelEncryptionHelper,
    githubApp,
    startAnalysisRun,
    startGenerationBatch,
    startPreviewBuild,
    triggerPreviewTeardown,
    triggerPreviewRedeployApp,
    emailSender,
}: ServicesParams): Services {
    const billingService = createBillingService(conn);
    const secretValues = buildSecretValues(conn);
    const previewkitOperationsService = new PreviewkitOperationsService(conn, buildSecretKeys(conn));
    const previewkitSecretsService = new PreviewkitSecretsService(conn, secretValues);
    const previewkitEnvironmentsService = new PreviewkitEnvironmentsService(conn);
    // Loki-backed log tails for the MCP get_build_logs / get_app_logs tools.
    // Undefined when PREVIEWKIT_LOKI_URL is unset (dev / self-host), mirroring the
    // SSE stream route; the logs service then reports "not configured".
    const buildLogStore =
        env.PREVIEWKIT_LOKI_URL != null ? new LokiLogStore(env.PREVIEWKIT_LOKI_URL, "build") : undefined;
    const appLogStore = env.PREVIEWKIT_LOKI_URL != null ? new LokiLogStore(env.PREVIEWKIT_LOKI_URL, "app") : undefined;
    const githubService = new GitHubInstallationService(conn, githubApp);
    const repoReader = new RepoReader(conn, githubApp);
    const repoIntrospectionService = new RepoIntrospectionService(repoReader);
    const applicationsService = new ApplicationsService(conn, encryptionHelper, env.FALLBACK_DEFAULT_BRANCH);
    const previewkitTrigger = new PreviewkitTriggerService(
        conn,
        githubService,
        billingService,
        startAnalysisRun,
        startPreviewBuild,
        triggerPreviewTeardown,
        triggerPreviewRedeployApp,
    );
    const diffsTriggerService = new DiffsTriggerService(conn, githubService, billingService, startAnalysisRun);
    const onboardingOptions = {
        previewkitClient: {
            deployApplicationMain: (applicationId: string, organizationId: string) =>
                previewkitTrigger.startMainBranchRun(applicationId, organizationId),
            redeploy: async (repoFullName: string, prNumber: number, organizationId: string) => {
                await previewkitTrigger.startRunForRedeploy({ repoFullName, prNumber }, { organizationId });
            },
            startRunForPullRequest: async (organizationId: string, githubRepositoryId: number, prNumber: number) => {
                await previewkitTrigger.startRunForPullRequest(organizationId, githubRepositoryId, prNumber);
            },
        },
        previewkitSecretsService,
        repoIntrospection: repoIntrospectionService,
        github: githubService,
        applications: applicationsService,
        diffsTrigger: diffsTriggerService,
        getVercelEncryptionHelper,
    };
    const onboardingManager = new OnboardingManager(conn, scenarioManager, encryptionHelper, onboardingOptions);
    const previewkitConfigService = new PreviewkitConfigService(conn, onboardingOptions);
    const rateLimiter = new RateLimiterService(conn);
    const onboardingAgentSession = new OnboardingAgentSessionService(conn, rateLimiter);
    const onboardingAnalytics = new OnboardingAnalytics(conn, analytics);
    const previewkitWrite = new PreviewkitWriteService(
        previewkitConfigService,
        previewkitSecretsService,
        previewkitTrigger,
    );
    const prCacheService = new PullRequestCacheService(conn, githubService);
    const apiKeysService = new ApiKeysService(conn);
    const applicationSetupService = new ApplicationSetupService(
        conn,
        onboardingManager,
        new ScenarioRecipeStore(conn),
        scenarioManager,
    );
    const suiteHealthService = new SuiteHealthService(conn);
    const branchesService = new BranchesService(conn, githubService, storageProvider, prCacheService);
    const falsePositiveCandidatesService = new FalsePositiveCandidateService(conn);
    const branchContributorService = new BranchContributorService(conn, githubService);

    return {
        admin: new AdminService(conn, auth, githubApp),
        auth: new AuthService(conn, new ParkedSessionStore(redisClient), new DemoEntrySourceStore(redisClient)),
        apiKeys: apiKeysService,
        branches: branchesService,
        deployments: new DeploymentsService(conn, previewkitTrigger),
        previewkitEnvFactory: new PreviewkitEnvFactoryService(conn, encryptionHelper),
        applications: applicationsService,
        applicationActivity: new ApplicationActivityService(conn),
        suiteHealth: suiteHealthService,
        suiteHealthFixPlan: new SuiteHealthFixPlanService(conn, githubService, suiteHealthService),
        testGenerations: new TestGenerationsService(conn, storageProvider, billingService),
        tests: new TestsService(conn),
        folders: new FoldersService(conn),
        scenarios: new ScenariosService(conn, scenarioManager),
        secrets: previewkitSecretsService,
        previewkitOperations: previewkitOperationsService,
        previewkitSecretStatus: new PreviewkitSecretStatusService(conn, previewkitSecretsService),
        previewkitLogs: new PreviewkitLogsService(previewkitEnvironmentsService, buildLogStore, appLogStore),
        github: githubService,
        falsePositiveCandidates: falsePositiveCandidatesService,
        mergeGate: new MergeGateService(
            conn,
            githubApp,
            env.MERGE_GATE_ENABLED,
            analytics,
            falsePositiveCandidatesService,
            diffsTriggerService,
            new MergeGateSlackNotifier(env.SLACK_BOT_TOKEN, env.MERGE_GATE_SLACK_CHANNEL),
        ),
        activationTriggerConfig: new ActivationTriggerConfigService(conn, githubService),
        branchContributor: branchContributorService,
        bugFixOutcome: new BugFixOutcomeService(conn, analytics, env.MERGE_GATE_ENABLED, branchContributorService),
        repoIntrospection: repoIntrospectionService,
        previewkitDiagnosis: new PreviewkitDiagnosisService(conn, env.PREVIEWKIT_LOKI_URL),
        onboarding: new OnboardingService(onboardingManager),
        organization: new OrganizationService(
            conn,
            auth,
            emailSender ?? buildEmailSender(env.RESEND_API_KEY, env.RESEND_FROM_EMAIL),
            analytics,
            env.APP_URL,
            env.INTERNAL_DOMAIN,
            env.RESEND_INVITES_FROM_EMAIL,
        ),
        rateLimiter,
        onboardingAgentSession,
        onboardingAnalytics,
        snapshotEdit: new SnapshotEditService(conn, startGenerationBatch, billingService),
        billing: billingService,
        applicationSetups: new ApplicationSetupsService(conn, applicationSetupService, apiKeysService),
        diffsTrigger: diffsTriggerService,
        previewkitTrigger,
        previewkitWrite,
        previewkitEnvironments: previewkitEnvironmentsService,
        usage: new UsageService(conn, billingService),
        getVercelEncryptionHelper,
    };
}
