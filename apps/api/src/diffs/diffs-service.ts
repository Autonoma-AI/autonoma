import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { triggerAnalysisRun } from "@autonoma/workflow";
import { env } from "../env";
import { buildGitHubApp } from "../github/github-app";
import { GitHubInstallationService } from "../github/github-installation.service";
import { DiffsTriggerService } from "./diffs-trigger.service";

const githubApp = buildGitHubApp(env);
const githubService = new GitHubInstallationService(db, githubApp);
const billingService = createBillingService(db);

export const diffsTriggerService = new DiffsTriggerService(db, githubService, billingService, triggerAnalysisRun);
