import { type PrismaClient, previewkitConfigRowsInclude } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import {
    documentFromPreviewkitConfigRows,
    parseStringRecord,
    parseUrl,
    reResolveSdkEndpoint,
    type SdkDocumentRoles,
    sdkRolesFromDocument,
} from "@autonoma/types";
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

    const [application, deployment, configuredRoles] = await Promise.all([
        db.application.findUnique({
            where: { id: applicationId },
            select: { id: true, signingSecretEnc: true, organizationId: true, disabled: true },
        }),
        db.branchDeployment.findUnique({
            where: { id: deploymentId },
            select: {
                id: true,
                webhookUrl: true,
                webhookHeaders: true,
                // The preview whose app URLs the SDK host resolves against. Absent for a BYO/external
                // preview (no PreviewKit environment), which leaves the stored endpoint untouched.
                branch: { select: { previewkitEnvironment: { select: { urls: true } } } },
            },
        }),
        resolveConfiguredSdkRoles(db, applicationId),
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

    // The stored endpoint's origin is the only trace of which app produced it, and one first stored
    // via the primary-app fallback stays stuck there after `sdk_implemented` moves. So re-resolve
    // against the config's EXPLICITLY declared SDK host (mapped to this preview's app URLs): a
    // differing origin re-points the host, everything else only corrects the path. Read here, not at
    // write time, so fixing a misroute is a config edit rather than a redeploy.
    //
    // An override is taken verbatim - it already carries the declared host and path, and rewriting it
    // would leave no way to aim a provision at an arbitrary endpoint on purpose.
    const envUrls = parseStringRecord(deployment.branch?.previewkitEnvironment?.urls);
    const declaredSdkAppUrl =
        configuredRoles.declaredAppName != null ? envUrls[configuredRoles.declaredAppName] : undefined;
    const sdkUrl =
        sdkUrlOverride ??
        reResolveSdkEndpoint({
            storedEndpoint: deployment.webhookUrl ?? undefined,
            declaredSdkAppUrl,
            declaredPath: configuredRoles.path,
        });
    if (sdkUrl == null) {
        throw new Error(`Deployment ${deploymentId} does not have an SDK URL configured`);
    }

    logHostRepoint({
        applicationId,
        deploymentId,
        storedEndpoint: sdkUrlOverride == null ? (deployment.webhookUrl ?? undefined) : undefined,
        resolvedUrl: sdkUrl,
        declaredAppName: configuredRoles.declaredAppName,
    });

    return {
        applicationId: application.id,
        sdkUrl,
        signingSecret,
        customHeaders,
    };
}

/**
 * Log the moment a stored SDK endpoint's HOST is actually re-pointed, so a run leaves a breadcrumb
 * ("dashboard -> server") instead of us inferring the correction from it succeeding.
 *
 * Silent on every non-event (no `storedEndpoint`, an unparseable origin, or the same-host preserve
 * path). Origins only reach the log - never the full URL's path, never the signing secret.
 */
function logHostRepoint(params: {
    applicationId: string;
    deploymentId: string;
    storedEndpoint: string | undefined;
    resolvedUrl: string;
    declaredAppName: string | undefined;
}): void {
    const { applicationId, deploymentId, storedEndpoint, resolvedUrl, declaredAppName } = params;
    if (storedEndpoint == null) return;

    const storedOrigin = parseUrl(storedEndpoint)?.origin;
    const resolvedOrigin = parseUrl(resolvedUrl)?.origin;
    if (storedOrigin == null || resolvedOrigin == null || storedOrigin === resolvedOrigin) return;

    rootLogger.child({ name: "resolveSdkConfig" }).info("Re-pointed SDK endpoint host to the declared SDK app", {
        applicationId,
        extra: { deploymentId, storedOrigin, resolvedOrigin, declaredSdkAppName: declaredAppName },
    });
}

/**
 * The `sdk_path` the application's LIVE preview config declares, or undefined when it declares none.
 *
 * Exported because the dry-run targets and the manual admin up ask the same question, and an `up` and
 * its `down` must reach the same URL or data is stranded. See {@link resolveConfiguredSdkRoles}.
 */
export async function resolveConfiguredSdkPath(db: PrismaClient, applicationId: string): Promise<string | undefined> {
    return (await resolveConfiguredSdkRoles(db, applicationId)).path;
}

/**
 * The SDK-host roles the LIVE preview config declares: the app that EXPLICITLY hosts the handler
 * (undefined when none does - a primary-app fallback is NOT it, so a host re-resolution can tell a
 * declaration from a guess) and the path it mounts it at.
 *
 * Read from `PreviewkitConfig`, not an environment's `resolvedConfig` (a deploy-time photo), so a
 * correction reaches readers without a redeploy. No config row yields empty roles, leaving the
 * stored endpoint untouched.
 */
export async function resolveConfiguredSdkRoles(db: PrismaClient, applicationId: string): Promise<SdkDocumentRoles> {
    const logger = rootLogger.child({ name: "resolveConfiguredSdkRoles" });

    const stored = await db.previewkitConfig.findUnique({
        where: { applicationId },
        include: previewkitConfigRowsInclude,
    });
    if (stored == null) return {};

    const roles = sdkRolesFromDocument(documentFromPreviewkitConfigRows(stored));
    if (roles.declaredAppName != null || roles.path != null) {
        logger.info("Preview config declares SDK endpoint roles", {
            applicationId,
            extra: { sdkAppName: roles.declaredAppName, sdkPath: roles.path },
        });
    }
    return roles;
}

/** The SDK endpoint an application's base preview resolves to right now, alongside the raw stored value it re-resolved. */
export interface ResolvedSdkEndpoint {
    /** The URL a provision against the base preview will POST to - host re-resolved to the declared SDK app. */
    sdkUrl?: string;
    /** The endpoint stored on the base deployment before re-resolution; a differing host from `sdkUrl` is the misroute. */
    storedEndpoint?: string;
    /** The app the live config EXPLICITLY declares as the SDK host, if any. */
    sdkAppName?: string;
}

/**
 * Where a provision against the application's BASE preview will land, using the exact re-resolution
 * {@link resolveSdkConfig} runs minus the signing secret. `get_config` surfaces this so a host
 * mismatch is visible up front; the resolved and raw stored URLs are both returned to compare hosts.
 */
export async function resolveSdkEndpointForApplication(
    db: PrismaClient,
    applicationId: string,
): Promise<ResolvedSdkEndpoint> {
    const [application, roles] = await Promise.all([
        db.application.findUnique({
            where: { id: applicationId },
            select: {
                mainBranch: {
                    select: {
                        deployment: { select: { webhookUrl: true } },
                        previewkitEnvironment: { select: { urls: true } },
                    },
                },
            },
        }),
        resolveConfiguredSdkRoles(db, applicationId),
    ]);

    const storedEndpoint = application?.mainBranch?.deployment?.webhookUrl ?? undefined;
    const envUrls = parseStringRecord(application?.mainBranch?.previewkitEnvironment?.urls);
    const declaredSdkAppUrl = roles.declaredAppName != null ? envUrls[roles.declaredAppName] : undefined;

    return {
        sdkUrl: reResolveSdkEndpoint({ storedEndpoint, declaredSdkAppUrl, declaredPath: roles.path }),
        storedEndpoint,
        sdkAppName: roles.declaredAppName,
    };
}
