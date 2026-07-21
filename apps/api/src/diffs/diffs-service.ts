import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { DiffsRunPreparer } from "@autonoma/test-updates";
import { temporalPipelineWorkflows } from "@autonoma/workflow";
import { env } from "../env";
import { buildGitHubApp } from "../github/github-app";
import { GitHubInstallationService } from "../github/github-installation.service";
import { DiffsTriggerService } from "./diffs-trigger.service";

const githubApp = buildGitHubApp(env);
const githubService = new GitHubInstallationService(db, githubApp);

const diffsRunPreparer = new DiffsRunPreparer({
    db,
    logger: logger.child({ name: "DiffsRunPreparer" }),
    workflows: temporalPipelineWorkflows,
    flags: {
        analysisAuthoritativeEnabled: env.ANALYSIS_AUTHORITATIVE_ENABLED,
        investigationShadowEnabled: env.INVESTIGATION_SHADOW_ENABLED,
    },
});

export const diffsTriggerService = new DiffsTriggerService(db, githubService, diffsRunPreparer, temporalPipelineWorkflows);
