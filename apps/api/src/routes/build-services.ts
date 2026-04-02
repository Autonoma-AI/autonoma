import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import { createBillingService, type BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import { BugLinker, BugMatcher } from "@autonoma/review";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import type { StorageProvider } from "@autonoma/storage";
import { CommitDiffHandler, type GenerationProvider, type TriggerDiffPlanner } from "@autonoma/test-updates";
import type { TriggerRunWorkflowParams } from "@autonoma/workflow";
import type { Auth } from "../auth";
import { GitHubInstallationService } from "../github/github-installation.service";
import { AdminService } from "./admin/admin.service";
import { ApiKeysService } from "./api-keys/api-keys.service";
import { ApplicationSetupsService } from "./app-generations/app-generations.service";
import { ApplicationsService } from "./applications/applications.service";
import { AuthService } from "./auth/auth.service";
import { BranchesService } from "./branches/branches.service";
import { BugsService } from "./bugs/bugs.service";
import { FoldersService } from "./folders/folders.service";
import { IssuesService } from "./issues/issues.service";
import { OnboardingManager } from "./onboarding/onboarding-manager";
import { OnboardingService } from "./onboarding/onboarding.service";
import { RunsService } from "./runs/runs.service";
import { ScenariosService } from "./scenarios/scenarios.service";
import { SkillsService } from "./skills/skills.service";
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
    runs: RunsService;
    testGenerations: TestGenerationsService;
    tests: TestsService;
    folders: FoldersService;
    scenarios: ScenariosService;
    skills: SkillsService;
    github: GitHubInstallationService;
    issues: IssuesService;
    onboarding: OnboardingService;
    snapshotEdit: SnapshotEditService;
    billing: BillingService;
    applicationSetups: ApplicationSetupsService;
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
    triggerDiffPlanner: TriggerDiffPlanner;
    scenarioManager: ScenarioManager;
    encryptionHelper: EncryptionHelper;
    generationProvider: GenerationProvider;
    githubApp: GitHubApp;
}

export function buildServices({
    conn,
    auth,
    storageProvider,
    triggerRunWorkflow,
    triggerGenerationReview,
    triggerRunReview,
    triggerDiffPlanner,
    scenarioManager,
    encryptionHelper,
    generationProvider,
    githubApp,
}: ServicesParams): Services {
    const registry = new ModelRegistry({
        models: { "smart-text": MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
    });
    const bugMatcher = new BugMatcher(registry.getModel({ model: "smart-text", tag: "bug-matching" }));
    const bugLinker = new BugLinker(bugMatcher);
    const billingService = createBillingService(conn);
    const onboardingManager = new OnboardingManager(conn, generationProvider, scenarioManager, encryptionHelper);

    return {
        admin: new AdminService(conn, auth),
        auth: new AuthService(conn),
        apiKeys: new ApiKeysService(conn),
        branches: new BranchesService(conn),
        bugs: new BugsService(conn, storageProvider, bugLinker),
        applications: new ApplicationsService(conn),
        runs: new RunsService(conn, storageProvider, triggerRunWorkflow, billingService),
        testGenerations: new TestGenerationsService(conn, storageProvider, generationProvider, billingService),
        tests: new TestsService(conn, storageProvider),
        folders: new FoldersService(conn),
        scenarios: new ScenariosService(conn, scenarioManager, encryptionHelper),
        skills: new SkillsService(conn),
        github: new GitHubInstallationService(conn, githubApp),
        issues: new IssuesService(conn, storageProvider, triggerGenerationReview, triggerRunReview),
        onboarding: new OnboardingService(onboardingManager),
        snapshotEdit: new SnapshotEditService(
            conn,
            generationProvider,
            new CommitDiffHandler(conn, githubApp, triggerDiffPlanner),
            billingService,
        ),
        billing: billingService,
        applicationSetups: new ApplicationSetupsService(conn),
    };
}
