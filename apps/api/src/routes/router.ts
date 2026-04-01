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
import { foldersRouter } from "./folders/folders.router";
import { issuesRouter } from "./issues/issues.router";
import { onboardingRouter } from "./onboarding/onboarding.router";
import { runsRouter } from "./runs/runs.router";
import { scenariosRouter } from "./scenarios/scenarios.router";
import { skillsRouter } from "./skills/skills.router";
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
    folders: foldersRouter,
    runs: runsRouter,
    generations: generationsRouter,
    issues: issuesRouter,
    tests: testsRouter,
    scenarios: scenariosRouter,
    skills: skillsRouter,
    github: githubRouter,
    onboarding: onboardingRouter,
    snapshotEdit: snapshotEditRouter,
});

export const appRouter: typeof appRouterImpl = appRouterImpl;

export type AppRouter = typeof appRouter;
