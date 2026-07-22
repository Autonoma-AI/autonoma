import type { DeployPreviewEnvironmentOutput, PreviewDeployEvent } from "@autonoma/types";
import { triggerPrDiffsJob } from "@autonoma/workflow";
import { env } from "../env";
import type { Logger } from "../logger";

/**
 * Once a PR preview env is READY, start the diffs run as a Temporal job so an
 * Autonoma review begins without the customer's `deployment_status` GitHub
 * Action. This is the PreviewKit-managed replacement for that Action: the runner
 * (control cluster) starts `triggerPrDiffsWorkflow`, whose activity runs the
 * shared preparer (snapshot + per-org analysis-vs-diffs, starting the run
 * top-level) - a Temporal job, no HTTP hop.
 *
 * Guards (each logs + returns), in order:
 * - Temporal not configured (`TEMPORAL_ADDRESS` unset) - no-op on dev/self-host;
 * - main-branch environment 0 (`prNumber <= 0`) - main diffs are push-driven;
 * - no `branchId` on the deploy event (repo not onboarded) - nothing to run;
 * - environment not fully ready (matches the old `deployment_status: success` gate);
 * - no primary url resolved.
 *
 * Fires for every PreviewKit-managed app: any org whose preview reaches `ready`
 * gets an Autonoma review, so this is the GitHub-Action-free path for all clients.
 *
 * Never rethrows meaningfully to the caller in `runDeploy`: the env is already
 * `ready`, so `runDeploy` isolates a throw here rather than mislabeling the outcome.
 */
export async function triggerDiffsAfterDeploy(
    event: PreviewDeployEvent,
    result: DeployPreviewEnvironmentOutput,
    logger: Logger,
): Promise<void> {
    const ids = { extra: { repo: event.repoFullName, pr: event.prNumber } };

    if (env.TEMPORAL_ADDRESS == null) {
        logger.debug("Temporal address not configured; skipping internal diffs trigger", ids);
        return;
    }
    if (event.prNumber <= 0) {
        logger.info("Skipping diffs trigger: main-branch environment (PR 0)", ids);
        return;
    }
    if (event.branchId == null) {
        logger.warn("Skipping diffs trigger: deploy event has no branchId", ids);
        return;
    }
    if (!result.ready) {
        logger.info("Skipping diffs trigger: environment not fully ready", ids);
        return;
    }
    if (result.primaryUrl == null) {
        logger.warn("Skipping diffs trigger: no primary url resolved", ids);
        return;
    }

    await triggerPrDiffsJob({
        organizationId: event.organizationId,
        branchId: event.branchId,
        headSha: event.headSha,
        baseSha: event.baseSha,
        url: result.primaryUrl,
    });
    logger.info("Diffs run workflow triggered for ready preview", {
        extra: { ...ids.extra, branchId: event.branchId, url: result.primaryUrl },
    });
}
