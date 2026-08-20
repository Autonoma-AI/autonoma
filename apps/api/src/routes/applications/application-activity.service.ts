import type { PrismaClient } from "@autonoma/db";
import type { ApplicationActivity } from "@autonoma/types";
import { Service } from "../service";
import { firstRunAt } from "./first-run-at";

export class ApplicationActivityService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async getForApplication(applicationId: string, organizationId: string): Promise<ApplicationActivity> {
        this.logger.info("Reading application activity", {
            application: { applicationId },
            organization: { organizationId },
        });

        const [pullRequest, firstRun, onboarding] = await Promise.all([
            // `prInfo` is the FeatureBranchInfo row, so its existence IS "this branch is a pull request".
            this.db.branch.findFirst({
                where: { applicationId, organizationId, prInfo: { isNot: null } },
                select: { id: true },
            }),
            firstRunAt(this.db, applicationId, organizationId),
            this.db.onboardingState.findUnique({
                where: { applicationId },
                select: { completedAt: true, previewEnvironmentMode: true },
            }),
        ]);

        const activity: ApplicationActivity = {
            hasEverOpenedPullRequest: pullRequest != null,
            hasEverRun: firstRun != null,
            firstRunAt: firstRun,
            liveSince: onboarding?.completedAt ?? undefined,
            previewMode: onboarding?.previewEnvironmentMode ?? undefined,
        };

        this.logger.info("Application activity resolved", {
            application: { applicationId },
            extra: {
                hasEverOpenedPullRequest: activity.hasEverOpenedPullRequest,
                hasEverRun: activity.hasEverRun,
            },
        });

        return activity;
    }
}
