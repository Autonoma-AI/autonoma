import { OnboardingState } from "./onboarding-state";

export class NoMainBranchError extends Error {
    constructor() {
        super("Application has no main branch");
    }
}

export class UrlState extends OnboardingState {
    readonly step = "url" as const;

    override async setUrl(productionUrl: string): Promise<void> {
        this.logger.info("Setting production URL");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "github", productionUrl },
        });

        await this.db.$transaction(async (tx) => {
            const app = await tx.application.findUnique({
                where: { id: this.applicationId },
                select: { mainBranch: { select: { deploymentId: true } } },
            });

            if (!app?.mainBranch?.deploymentId) {
                throw new NoMainBranchError();
            }

            await tx.webDeployment.update({
                where: { deploymentId: app.mainBranch.deploymentId },
                data: { url: productionUrl },
            });
        });
    }
}
