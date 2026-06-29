import { OnboardingState } from "./onboarding-state";

/**
 * Per-PR diff trigger - the loop the customer is actually buying. Reached once a
 * preview env is verified.
 *
 * - PreviewKit mode: automatic. PreviewKit already triggers diff analysis after
 *   each PR deploy, so the screen is a confirmation and `goLive` is available
 *   immediately.
 * - BYO mode: optimistic. The single pasted `deployment_status` workflow drives
 *   diffs, but we can't verify it was committed, so `goLive` is allowed
 *   immediately; the first real PR signal records `diffTriggerConfirmedAt`.
 */
export class DiffTriggerState extends OnboardingState {
    readonly step = "diff_trigger" as const;

    override async goLive(): Promise<void> {
        this.logger.info("Going live from diff_trigger");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "completed", completedAt: new Date(), previewVerificationStatus: "ready" },
        });
    }
}
