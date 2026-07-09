import { githubRouter } from "../github/github.router";
import { router } from "../trpc";
import { adminRouter } from "./admin/admin.router";
import { apiKeysRouter } from "./api-keys/api-keys.router";
import { applicationSetupsRouter } from "./app-generations/app-generations.router";
import { applicationsRouter } from "./applications/applications.router";
import { authRouter } from "./auth/auth.router";
import { billingRouter } from "./billing/billing.router";
import { branchesRouter } from "./branches/branches.router";
import { bugsRouter } from "./bugs/bugs.router";
import { deploymentsRouter } from "./deployments/deployments.router";
import { foldersRouter } from "./folders/folders.router";
import { issuesRouter } from "./issues/issues.router";
import { onboardingRouter } from "./onboarding/onboarding.router";
import { orgSecretsRouter } from "./org-secrets/org-secrets.router";
import { previewAccessRouter } from "./preview-access/preview-access.router";
import { scenariosRouter } from "./scenarios/scenarios.router";
import { secretsRouter } from "./secrets/secrets.router";
import { snapshotEditRouter } from "./snapshot-edit/snapshot-edit.router";
import { generationsRouter } from "./test-generations/test-generations.router";
import { testsRouter } from "./tests/tests.router";

const appRouterImpl = router({
    admin: adminRouter,
    apiKeys: apiKeysRouter,
    applicationSetups: applicationSetupsRouter,
    auth: authRouter,
    billing: billingRouter,
    applications: applicationsRouter,
    branches: branchesRouter,
    bugs: bugsRouter,
    deployments: deploymentsRouter,
    folders: foldersRouter,
    generations: generationsRouter,
    issues: issuesRouter,
    tests: testsRouter,
    scenarios: scenariosRouter,
    secrets: secretsRouter,
    orgSecrets: orgSecretsRouter,
    github: githubRouter,
    onboarding: onboardingRouter,
    previewAccess: previewAccessRouter,
    snapshotEdit: snapshotEditRouter,
});

export const appRouter: typeof appRouterImpl = appRouterImpl;

export type AppRouter = typeof appRouter;
