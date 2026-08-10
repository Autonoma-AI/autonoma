import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { applySdkPath, sdkPathFromDocument } from "@autonoma/types";
import type { EncryptionHelper } from "./encryption";

export interface SdkConfig {
    applicationId: string;
    sdkUrl: string;
    /** Plain signing secret - already decrypted from the stored encrypted value. */
    signingSecret: string;
    customHeaders?: Record<string, string>;
}

/**
 * Resolve the SDK endpoint config (URL, headers, decrypted signing secret) for
 * a given application + deployment pair.
 *
 * Extracted from ScenarioManager so callers that need only the config - evals,
 * capture/generation tooling - can obtain it without constructing the full manager.
 * Production callers that need the full lifecycle (up/down/ingest) should use
 * ScenarioManager, which delegates to this function internally.
 */
export async function resolveSdkConfig(params: {
    applicationId: string;
    deploymentId: string;
    db: PrismaClient;
    encryption: EncryptionHelper;
    sdkUrlOverride?: string;
}): Promise<SdkConfig> {
    const { applicationId, deploymentId, db, encryption, sdkUrlOverride } = params;

    const [application, deployment, configuredSdkPath] = await Promise.all([
        db.application.findUnique({
            where: { id: applicationId },
            select: { id: true, signingSecretEnc: true, organizationId: true, disabled: true },
        }),
        db.branchDeployment.findUnique({
            where: { id: deploymentId },
            select: { id: true, webhookUrl: true, webhookHeaders: true },
        }),
        resolveConfiguredSdkPath(db, applicationId),
    ]);

    if (application == null) {
        throw new Error(`Application ${applicationId} not found`);
    }
    if (application.disabled) {
        throw new Error(`Application ${applicationId} is disabled`);
    }
    if (application.signingSecretEnc == null) {
        throw new Error(`Application ${applicationId} does not have a signing secret configured`);
    }

    if (deployment == null) {
        throw new Error(`Deployment ${deploymentId} not found`);
    }

    const signingSecret = encryption.decrypt(application.signingSecretEnc);
    const customHeaders =
        deployment.webhookHeaders != null ? (deployment.webhookHeaders as Record<string, string>) : undefined;

    // The stored row's origin is authoritative - it is the app that was actually
    // deployed - but its path was composed by whichever trigger wrote it, all of
    // which assume the convention. The config is where an app that mounts the
    // handler elsewhere says so, and it is read HERE rather than at write time so
    // that fixing a wrong path is a config edit, not a redeploy of every live
    // environment.
    //
    // An override is taken verbatim: it replaces the whole endpoint (not just its
    // host), it is resolved server-side from a dry-run target that already carries
    // the declared path, and rewriting a caller's explicit URL would leave no way
    // to aim a provision at an arbitrary endpoint on purpose.
    const sdkUrl =
        sdkUrlOverride ??
        (deployment.webhookUrl != null ? applySdkPath(deployment.webhookUrl, configuredSdkPath) : undefined);
    if (sdkUrl == null) {
        throw new Error(`Deployment ${deploymentId} does not have an SDK URL configured`);
    }

    return {
        applicationId: application.id,
        sdkUrl,
        signingSecret,
        customHeaders,
    };
}

/**
 * The `sdk_path` the application's LIVE preview config declares, or undefined when it declares none - which
 * includes every application whose previews Autonoma does not build (no config row at all), leaving their stored
 * endpoint untouched.
 *
 * Read from `PreviewkitConfig` rather than from an environment's `resolvedConfig`: that column is a photo taken at
 * deploy time, so a path corrected after a preview went up would not reach any reader until it redeployed.
 *
 * Exported because the same question is asked outside a provision - the onboarding dry-run targets and the manual
 * admin up both compose an endpoint of their own - and the answer has to be identical everywhere, or an `up` and
 * the `down` that follows it can reach different URLs and strand data in the customer's database.
 */
export async function resolveConfiguredSdkPath(db: PrismaClient, applicationId: string): Promise<string | undefined> {
    const logger = rootLogger.child({ name: "resolveConfiguredSdkPath" });

    const stored = await db.previewkitConfig.findUnique({
        where: { applicationId },
        select: { document: true },
    });
    if (stored == null) return undefined;

    const path = sdkPathFromDocument(stored.document);
    if (path != null) {
        logger.info("Preview config declares an SDK endpoint path", { applicationId, extra: { sdkPath: path } });
    }
    return path;
}
