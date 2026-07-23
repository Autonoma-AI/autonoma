import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { encryptionHelper } from "../context";
import { upsertVercelEnvVar } from "./vercel-project-api";

const VERCEL_MARKETPLACE_SSO_URL = "https://vercel.com/api/marketplace/sso";
const AUTONOMA_SHARED_SECRET_KEY = "AUTONOMA_SHARED_SECRET";
const SHARED_SECRET_ENV_TARGETS = ["production", "preview", "development"];

/**
 * Builds a link that routes through Vercel's own marketplace SSO broker
 * instead of pointing straight at our app. Vercel confirms the clicking
 * browser is a member of `teamId` (using Vercel's own session - the user is
 * already inside Vercel's dashboard) and redirects back to our integration's
 * registered "Redirect Login URL" (`/v1/vercel/callback?mode=sso`) with an SSO
 * code and the `url` param echoed back unchanged, which we exchange for a
 * session and use as the final redirect target.
 *
 * This is what lets a Vercel Check's "Details" link authenticate any team
 * member, not just whoever originally clicked "Open in Autonoma" - without
 * it, anyone else would hit our login wall with no account to sign into.
 */
export function buildVercelSsoRedirectUrl(vercelInstallationId: string, teamId: string, targetUrl: string): string {
    const params = new URLSearchParams({
        integrationConfigurationId: vercelInstallationId,
        teamId,
        url: targetUrl,
    });
    return `${VERCEL_MARKETPLACE_SSO_URL}?${params.toString()}`;
}

/**
 * Redis key used to stash the organization a Vercel SSO login should land the
 * user in, since better-auth's session-created hook has no other channel to
 * receive it. Short TTL - it only needs to survive the redirect chain.
 */
export function vercelPreferredOrgKey(userId: string): string {
    return `vercel-preferred-org:${userId}`;
}

/**
 * Computes the lowest free `${baseSlug}` / `${baseSlug}-N` slug given the set of
 * slugs already in use. Shared by the org- and application-scoped resolvers
 * below so the suffix arithmetic isn't duplicated per model.
 */
function resolveFreeSlug(baseSlug: string, existingSlugs: Set<string>): string {
    if (!existingSlugs.has(baseSlug)) return baseSlug;

    const suffixPattern = new RegExp(`^${escapeRegExp(baseSlug)}-(\\d+)$`);
    const usedSuffixes = new Set<number>();
    for (const slug of existingSlugs) {
        const match = suffixPattern.exec(slug);
        if (match?.[1] != null) usedSuffixes.add(Number.parseInt(match[1], 10));
    }

    let suffix = 2;
    while (usedSuffixes.has(suffix)) suffix++;

    return `${baseSlug}-${suffix}`;
}

/**
 * Resolves a unique organization slug derived from `baseSlug`, appending a
 * numeric suffix (`-2`, `-3`, ...) when the base slug is already taken.
 *
 * Fetches every slug matching `${baseSlug}` or `${baseSlug}-%` in a single
 * query, then computes the lowest free suffix in memory - avoids issuing one
 * `findUnique` per candidate suffix.
 */
export async function resolveUniqueOrgSlug(baseSlug: string): Promise<string> {
    const logger = rootLogger.child({ name: "resolveUniqueOrgSlug" });
    logger.info("Resolving unique org slug", { baseSlug });

    const existingOrgs = await db.organization.findMany({
        where: {
            OR: [{ slug: baseSlug }, { slug: { startsWith: `${baseSlug}-` } }],
        },
        select: { slug: true },
    });

    const resolvedSlug = resolveFreeSlug(baseSlug, new Set(existingOrgs.map((org) => org.slug)));
    logger.info("Resolved unique org slug", { baseSlug, resolvedSlug });
    return resolvedSlug;
}

/**
 * Same as {@link resolveUniqueOrgSlug}, scoped to applications within a single
 * organization (`Application` slugs are only unique per-org, per the
 * `@@unique([slug, organizationId])` schema constraint).
 */
export async function resolveUniqueApplicationSlug(baseSlug: string, organizationId: string): Promise<string> {
    const logger = rootLogger.child({ name: "resolveUniqueApplicationSlug" });
    logger.info("Resolving unique application slug", { baseSlug, organizationId });

    const existingApps = await db.application.findMany({
        where: {
            organizationId,
            OR: [{ slug: baseSlug }, { slug: { startsWith: `${baseSlug}-` } }],
        },
        select: { slug: true },
    });

    const resolvedSlug = resolveFreeSlug(baseSlug, new Set(existingApps.map((app) => app.slug)));
    logger.info("Resolved unique application slug", { baseSlug, organizationId, resolvedSlug });
    return resolvedSlug;
}

/**
 * Same as {@link resolveUniqueApplicationSlug}, but for the `name` field
 * (`@@unique([name, organizationId])`). Vercel project names aren't unique
 * across an account's projects the way our application names are within an
 * org, so this must be resolved independently of the slug.
 */
export async function resolveUniqueApplicationName(baseName: string, organizationId: string): Promise<string> {
    const logger = rootLogger.child({ name: "resolveUniqueApplicationName" });
    logger.info("Resolving unique application name", { baseName, organizationId });

    const existingApps = await db.application.findMany({
        where: {
            organizationId,
            OR: [{ name: baseName }, { name: { startsWith: `${baseName}-` } }],
        },
        select: { name: true },
    });

    const resolvedName = resolveFreeSlug(baseName, new Set(existingApps.map((app) => app.name)));
    logger.info("Resolved unique application name", { baseName, organizationId, resolvedName });
    return resolvedName;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.values(value).every((v) => typeof v === "string");
}

/**
 * Writes the Vercel deployment-protection bypass secret onto the application's
 * main branch deployment's `webhookHeaders`, merged with whatever is already
 * there. This is the only header set consumed by both the SDK's HTTP calls
 * (`sdk-config-resolver.ts`) and (once threaded through) real test execution's
 * browser context - without it, connecting a Vercel project does nothing to
 * help either path reach a protected preview.
 */
export async function applyVercelProtectionBypassHeader(applicationId: string, bypassSecret: string): Promise<void> {
    const logger = rootLogger.child({ name: "applyVercelProtectionBypassHeader" });

    const app = await db.application.findUnique({
        where: { id: applicationId },
        select: { mainBranch: { select: { deploymentId: true } } },
    });
    const deploymentId = app?.mainBranch?.deploymentId;
    if (deploymentId == null) {
        logger.warn("No main branch deployment to apply Vercel bypass header to", { applicationId });
        return;
    }

    const deployment = await db.branchDeployment.findUnique({
        where: { id: deploymentId },
        select: { webhookHeaders: true },
    });
    const existingHeaders = isStringRecord(deployment?.webhookHeaders) ? deployment.webhookHeaders : {};

    await db.branchDeployment.update({
        where: { id: deploymentId },
        data: { webhookHeaders: { ...existingHeaders, "x-vercel-protection-bypass": bypassSecret } },
    });

    logger.info("Applied Vercel protection bypass header to deployment", { applicationId, deploymentId });
}

/**
 * Pushes the application's webhook shared secret into the linked Vercel project's
 * own env vars as `AUTONOMA_SHARED_SECRET`, so the user never has to copy it into
 * the Vercel dashboard by hand. Best-effort: never throws, since this is an
 * automation on top of a project link/connect that must succeed either way.
 */
export async function applyVercelSharedSecretEnv(
    applicationId: string,
    vercelProjectId: string,
    teamId: string | undefined,
    accessToken: string,
): Promise<void> {
    const logger = rootLogger.child({ name: "applyVercelSharedSecretEnv" });

    const app = await db.application.findUnique({
        where: { id: applicationId },
        select: { signingSecretEnc: true },
    });
    if (app?.signingSecretEnc == null) {
        logger.info("Application has no shared secret yet, skipping Vercel env sync", { applicationId });
        return;
    }

    try {
        const sharedSecret = encryptionHelper.decrypt(app.signingSecretEnc);
        await upsertVercelEnvVar(
            vercelProjectId,
            teamId,
            accessToken,
            AUTONOMA_SHARED_SECRET_KEY,
            sharedSecret,
            SHARED_SECRET_ENV_TARGETS,
        );
        logger.info("Synced AUTONOMA_SHARED_SECRET to Vercel project", { applicationId, vercelProjectId });
    } catch (error) {
        logger.error("Failed to sync AUTONOMA_SHARED_SECRET to Vercel project", {
            applicationId,
            vercelProjectId,
            error,
        });
    }
}
