import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { analytics } from "@autonoma/analytics";
import { createBillingService, type BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import { LokiLogStore } from "@autonoma/logger/loki-log-store";
import { ScenarioRecipeStore, type EncryptionHelper, type ScenarioManager } from "@autonoma/scenario";
import type { StorageProvider } from "@autonoma/storage";
import type { GenerationProvider } from "@autonoma/test-updates";
import type { TriggerPreviewRedeployAppParams, PreviewTeardownTarget } from "@autonoma/types";
import type { AnalysisRunWorkflowInput, PreviewBuildWorkflowInput } from "@autonoma/workflow";
import type Redis from "ioredis";
import { ApplicationSetupService } from "../application-setup/application-setup.service";
import type { Auth } from "../auth";
import { DemoEntrySourceStore } from "../demo/demo-entry-source.store";
import { ParkedSessionStore } from "../demo/parked-session.store";
import { DiffsTriggerService } from "../diffs/diffs-trigger.service";
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
import { PreviewkitSecretStatusService } from "../previewkit/previewkit-secret-status.service";
import { PreviewkitSecretsService } from "../previewkit/previewkit-secrets.service";
import { PreviewkitTriggerService } from "../previewkit/previewkit-trigger.service";
import { PreviewkitWriteService } from "../previewkit/previewkit-write.service";
import { buildSecretValues } from "../previewkit/secret-store";
import { RateLimiterService } from "../rate-limit/rate-limiter.service";
import { AdminService } from "./admin/admin.service";
import { ApiKeysService } from "./api-keys/api-keys.service";
import { ApplicationSetupsService } from "./app-generations/app-generations.service";
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
import { ScenariosService } from "./scenarios/scenarios.service";
import { SnapshotEditService } from "./snapshot-edit/snapshot-edit.service";
import { TestGenerationsService } from "./test-generations/test-generations.service";
import { TestsService } from "./tests/tests.service";

export interface Services {
    admin: AdminService;
    auth: AuthService;
    apiKeys: ApiKeysService;
    applications: ApplicationsService;
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
    generationProvider: GenerationProvider;
    githubApp: GitHubApp;
    /** Required, not optional: production and tests must exercise the same seam. */
    startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<void>;
    startPreviewBuild: (input: PreviewBuildWorkflowInput) => Promise<void>;
    triggerPreviewTeardown: (target: PreviewTeardownTarget) => Promise<void>;
    triggerPreviewRedeployApp: (params: TriggerPreviewRedeployAppParams) => Promise<void>;
}

/** Gemini text model powering PreviewKit's AI suggestion and diagnosis enrichment passes. */
const PREVIEWKIT_AI_MODEL_ID = "gemini-3-flash-preview";

export function buildServices({
    conn,
    auth,
    redisClient,
    storageProvider,
    scenarioManager,
    encryptionHelper,
    getVercelEncryptionHelper,
    generationProvider,
    githubApp,
    startAnalysisRun,
    startPreviewBuild,
    triggerPreviewTeardown,
    triggerPreviewRedeployApp,
}: ServicesParams): Services {
    const billingService = createBillingService(conn);
    const secretValues = buildSecretValues(conn);
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
    const previewkitAiModel = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY }).languageModel(
        PREVIEWKIT_AI_MODEL_ID,
    );
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
    const diffsTriggerService = new DiffsTriggerService(conn, githubService, startAnalysisRun);
    const onboardingOptions = {
        previewkitClient: {
            deployApplicationMain: async (applicationId: string, organizationId: string) => {
                await previewkitTrigger.startMainBranchRun(applicationId, organizationId);
            },
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
        generationProvider,
        onboardingManager,
        new ScenarioRecipeStore(conn),
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
        suiteHealth: suiteHealthService,
        suiteHealthFixPlan: new SuiteHealthFixPlanService(conn, githubService, suiteHealthService),
        testGenerations: new TestGenerationsService(conn, storageProvider, billingService),
        tests: new TestsService(conn),
        folders: new FoldersService(conn),
        scenarios: new ScenariosService(conn, scenarioManager),
        secrets: previewkitSecretsService,
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
        previewkitDiagnosis: new PreviewkitDiagnosisService(conn, env.PREVIEWKIT_LOKI_URL, previewkitAiModel),
        onboarding: new OnboardingService(onboardingManager),
        rateLimiter,
        onboardingAgentSession,
        onboardingAnalytics,
        snapshotEdit: new SnapshotEditService(conn, generationProvider, billingService),
        billing: billingService,
        applicationSetups: new ApplicationSetupsService(conn, applicationSetupService, apiKeysService),
        diffsTrigger: diffsTriggerService,
        previewkitTrigger,
        previewkitWrite,
        previewkitEnvironments: previewkitEnvironmentsService,
        getVercelEncryptionHelper,
    };
}
