import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { analytics } from "@autonoma/analytics";
import { createBillingService, type BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import { LokiLogStore } from "@autonoma/logger/loki-log-store";
import { ScenarioRecipeStore, type EncryptionHelper, type ScenarioManager } from "@autonoma/scenario";
import { KmsKeyProvider, SecretKeys, SecretValues } from "@autonoma/secrets";
import type { StorageProvider } from "@autonoma/storage";
import { DiffsRunPreparer, type GenerationProvider } from "@autonoma/test-updates";
import type {
    TriggerPreviewDeployParams,
    TriggerPreviewRedeployAppParams,
    TriggerPreviewTeardownParams,
} from "@autonoma/types";
import type { PipelineWorkflows } from "@autonoma/workflow";
import { KMSClient } from "@aws-sdk/client-kms";
import { ApplicationSetupService } from "../application-setup/application-setup.service";
import type { Auth } from "../auth";
import { DiffsTriggerService } from "../diffs/diffs-trigger.service";
import { env } from "../env";
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
import { SecretValueMirror } from "../previewkit/secret-value-mirror";
import { RateLimiterService } from "../rate-limit/rate-limiter.service";
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
import { OnboardingAgentSessionService } from "./onboarding/onboarding-agent-session.service";
import { OnboardingManager } from "./onboarding/onboarding-manager";
import { OnboardingService } from "./onboarding/onboarding.service";
import { PreviewkitConfigService } from "./onboarding/previewkit-config-service";
import { OrgSecretsService } from "./org-secrets/org-secrets.service";
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
    testGenerations: TestGenerationsService;
    tests: TestsService;
    folders: FoldersService;
    scenarios: ScenariosService;
    secrets: PreviewkitSecretsService;
    previewkitSecretStatus: PreviewkitSecretStatusService;
    previewkitLogs: PreviewkitLogsService;
    orgSecrets: OrgSecretsService;
    github: GitHubInstallationService;
    falsePositiveCandidates: FalsePositiveCandidateService;
    mergeGate: MergeGateService;
    branchContributor: BranchContributorService;
    bugFixOutcome: BugFixOutcomeService;
    repoIntrospection: RepoIntrospectionService;
    previewkitDiagnosis: PreviewkitDiagnosisService;
    issues: IssuesService;
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
    getVercelEncryptionHelper: () => EncryptionHelper;
}

export interface ServicesParams {
    conn: PrismaClient;
    auth: Auth;
    storageProvider: StorageProvider;
    scenarioManager: ScenarioManager;
    encryptionHelper: EncryptionHelper;
    getVercelEncryptionHelper: () => EncryptionHelper;
    generationProvider: GenerationProvider;
    githubApp: GitHubApp;
    pipelineWorkflows: PipelineWorkflows;
    triggerPreviewDeploy: (params: TriggerPreviewDeployParams) => Promise<void>;
    triggerPreviewTeardown: (params: TriggerPreviewTeardownParams) => Promise<void>;
    triggerPreviewRedeployApp: (params: TriggerPreviewRedeployAppParams) => Promise<void>;
}

/** Gemini text model powering PreviewKit's AI suggestion and diagnosis enrichment passes. */
const PREVIEWKIT_AI_MODEL_ID = "gemini-3-flash-preview";

export function buildServices({
    conn,
    auth,
    storageProvider,
    scenarioManager,
    encryptionHelper,
    getVercelEncryptionHelper,
    generationProvider,
    githubApp,
    pipelineWorkflows,
    triggerPreviewDeploy,
    triggerPreviewTeardown,
    triggerPreviewRedeployApp,
}: ServicesParams): Services {
    const billingService = createBillingService(conn);
    const secretValueMirror = buildSecretValueMirror(conn);
    const previewkitSecretsService = new PreviewkitSecretsService(env.S3_REGION, conn, secretValueMirror);
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
        triggerPreviewDeploy,
        triggerPreviewTeardown,
        triggerPreviewRedeployApp,
    );
    const diffsRunPreparer = new DiffsRunPreparer({
        db: conn,
        logger: logger.child({ name: "DiffsRunPreparer" }),
        workflows: pipelineWorkflows,
        flags: {
            analysisAuthoritativeEnabled: env.ANALYSIS_AUTHORITATIVE_ENABLED,
            investigationShadowEnabled: env.INVESTIGATION_SHADOW_ENABLED,
        },
    });
    const diffsTriggerService = new DiffsTriggerService(conn, githubService, diffsRunPreparer, pipelineWorkflows);
    const onboardingOptions = {
        previewkitClient: {
            isConfigured: () => env.PREVIEWKIT_ENABLED,
            deployApplicationMain: async (applicationId: string, organizationId: string) => {
                await previewkitTrigger.deployMainBranch(applicationId, organizationId);
            },
            redeploy: async (repoFullName: string, prNumber: number, organizationId: string) => {
                await previewkitTrigger.redeploy(repoFullName, prNumber, organizationId);
            },
            deployPullRequest: async (organizationId: string, githubRepositoryId: number, prNumber: number) => {
                await previewkitTrigger.deployPullRequest(organizationId, githubRepositoryId, prNumber);
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
    const branchesService = new BranchesService(conn, githubService, storageProvider, prCacheService);
    const falsePositiveCandidatesService = new FalsePositiveCandidateService(conn, branchesService);
    const branchContributorService = new BranchContributorService(conn, githubService);

    return {
        admin: new AdminService(conn, auth, githubApp),
        auth: new AuthService(conn),
        apiKeys: apiKeysService,
        branches: branchesService,
        bugs: new BugsService(conn, storageProvider, analytics, env.APP_URL),
        deployments: new DeploymentsService(conn, previewkitTrigger),
        previewkitEnvFactory: new PreviewkitEnvFactoryService(conn, encryptionHelper),
        applications: applicationsService,
        testGenerations: new TestGenerationsService(conn, storageProvider, billingService),
        tests: new TestsService(conn),
        folders: new FoldersService(conn),
        scenarios: new ScenariosService(conn, scenarioManager),
        secrets: previewkitSecretsService,
        previewkitSecretStatus: new PreviewkitSecretStatusService(conn, previewkitSecretsService),
        previewkitLogs: new PreviewkitLogsService(previewkitEnvironmentsService, buildLogStore, appLogStore),
        orgSecrets: new OrgSecretsService(conn, env.AWS_REGION ?? "us-east-1", secretValueMirror),
        github: githubService,
        falsePositiveCandidates: falsePositiveCandidatesService,
        mergeGate: new MergeGateService(
            conn,
            githubApp,
            env.MERGE_GATE_ENABLED,
            analytics,
            falsePositiveCandidatesService,
            new MergeGateSlackNotifier(env.SLACK_BOT_TOKEN, env.MERGE_GATE_SLACK_CHANNEL),
        ),
        branchContributor: branchContributorService,
        bugFixOutcome: new BugFixOutcomeService(conn, analytics, env.MERGE_GATE_ENABLED, branchContributorService),
        repoIntrospection: repoIntrospectionService,
        previewkitDiagnosis: new PreviewkitDiagnosisService(conn, env.PREVIEWKIT_LOKI_URL, previewkitAiModel),
        issues: new IssuesService(conn, storageProvider),
        onboarding: new OnboardingService(onboardingManager),
        rateLimiter,
        onboardingAgentSession,
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

/**
 * The Postgres mirror for previewkit secret writes, or a disabled one when this
 * environment has no CMK. `PREVIEWKIT_SECRETS_CMK` is the marker that an
 * environment has been provisioned for database-stored secrets; without it there
 * is nothing to unwrap a key generation with, so writes stay AWS-only. Unwrapping
 * itself never names the CMK - a symmetric KMS ciphertext identifies its own key.
 */
function buildSecretValueMirror(conn: PrismaClient): SecretValueMirror {
    if (env.PREVIEWKIT_SECRETS_CMK == null) return new SecretValueMirror();

    const kms = new KMSClient({ region: env.AWS_REGION ?? "us-east-1" });
    const keys = new SecretKeys(conn, new KmsKeyProvider(kms, env.PREVIEWKIT_SECRETS_CMK));
    return new SecretValueMirror(new SecretValues(conn, keys));
}
