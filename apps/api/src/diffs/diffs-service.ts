import { db } from "@autonoma/db";
import { cancelDiffsJob, triggerDiffsJob, triggerInvestigationJob } from "@autonoma/workflow";
import { env } from "../env";
import { buildGitHubApp } from "../github/github-app";
import { GitHubInstallationService } from "../github/github-installation.service";
import { DiffsTriggerService } from "./diffs-trigger.service";

const githubApp = buildGitHubApp(env);
const githubService = new GitHubInstallationService(db, githubApp);

export const diffsTriggerService = new DiffsTriggerService(
    db,
    githubService,
    triggerDiffsJob,
    cancelDiffsJob,
    triggerInvestigationJob,
);
