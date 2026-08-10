import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { resolveConfiguredSdkPath } from "@autonoma/scenario";
import { declaredSdkPath, previewConfigSchema, resolveSdkAppName } from "@autonoma/types";
import { z } from "zod";
import { type DeployFreshness, deployFreshness } from "../../previewkit/deploy-freshness";
import { buildSdkUrl } from "./sdk-url";

export type SdkDryRunTargetSource = "previewkit" | "external" | "vercel";

/**
 * Whether a target can be validated/dry-run against right now. Previews are
 * PR-keyed, so an open PR is always listed - even before (or without) a
 * deployed preview - with the reason it is not usable yet:
 *  - "ready": deployed and reachable.
 *  - "building": a PreviewKit deploy is in flight; no URL yet.
 *  - "failed": the PreviewKit deploy failed (see `error`).
 *  - "no_preview": the PR has no preview environment at all (e.g. a draft PR).
 */
export type SdkDryRunTargetAvailability = "ready" | "building" | "failed" | "no_preview";

/**
 * A preview environment the SDK dry-run can target. The endpoint is the SDK app's
 * preview origin plus the path its config declares, defaulting to the
 * `/api/autonoma` convention when it declares none.
 */
export interface SdkDryRunTarget {
    id: string;
    kind: "main" | "pr";
    source: SdkDryRunTargetSource;
    label: string;
    prNumber?: number;
    environmentId?: string;
    /** `owner/repo` of the PreviewKit env, for addressing its log stream. Absent for external targets. */
    repoFullName?: string;
    sdkAppName?: string;
    status?: string;
    availability: SdkDryRunTargetAvailability;
    /** PreviewKit's failure reason, when availability is "failed". */
    error?: string;
    /** Branch + commit the PreviewKit env is deployed (or deploying) at - the UI shows these as the build cause. Absent for external targets. */
    headRef?: string;
    headSha?: string;
    /**
     * The branch this target is the preview for, whoever deploys it.
     *
     * Distinct from {@link headRef}, which is what PreviewKit recorded for its own
     * environment and is therefore absent on targets Autonoma does not build. This
     * is the branch as the repository knows it, so a caller sitting in a checkout
     * can match the preview to the code in front of it instead of guessing from a
     * title - which is what {@link isAutoDetected} does, and why it is only a hint.
     */
    branchName?: string;
    /** Absent until the preview has deployed (availability "building"/"failed"/"no_preview"). */
    previewUrl?: string;
    sdkUrl?: string;
    /**
     * How far `availability` can be trusted, from the age of the last deploy. It is
     * derived from what the deploy pipeline recorded and never re-probed, so a
     * "ready" target whose preview was torn down out of band still reads ready.
     * Absent for targets Autonoma does not deploy itself.
     */
    freshness?: DeployFreshness;
    requiresSharedSecretInput: boolean;
    /** True when this is the auto-detected "SDK implementation" PR (by title convention). */
    isAutoDetected: boolean;
}

export interface SdkDryRunTargets {
    targets: SdkDryRunTarget[];
    autoDetectedTargetId?: string;
}

const PreviewUrlsSchema = z.record(z.string(), z.string());

const MAIN_ENVIRONMENT_PR_NUMBER = 0;

/** Upper bound on preview-env rows read per listing; far above any real open-PR count. */
const MAX_PREVIEWKIT_ENVIRONMENTS = 200;

/**
 * A PR is treated as the SDK implementation PR when its title (or branch) names
 * the autonoma-sdk convention, e.g. "feat: autonoma-sdk". Iterating the SDK on
 * that PR's preview env dissolves the slow push-to-main rebuild loop.
 */
function matchesSdkConvention(title: string | undefined, branchName: string): boolean {
    const haystacks = [title, branchName].filter((value): value is string => value != null);
    return haystacks.some((value) => /autonoma[-_\s]?sdk/i.test(value));
}

/**
 * A malformed `urls` column degrades the env to URL-less ("building" forever in
 * the UI), so the parse failure is logged rather than silently swallowed.
 */
function parsePreviewUrls(urls: unknown, environmentId: string, logger: Logger): Record<string, string> {
    const parsed = PreviewUrlsSchema.safeParse(urls);
    if (!parsed.success) {
        logger.warn("Preview environment has malformed urls; treating as not deployed", {
            extra: { environmentId, issues: parsed.error.issues },
        });
        return {};
    }
    return parsed.data;
}

function firstPreviewUrl(urls: Record<string, string>): string | undefined {
    for (const url of Object.values(urls)) {
        if (url.length > 0) return url;
    }
    return undefined;
}

function firstPreviewAppName(urls: Record<string, string>): string | undefined {
    for (const [appName, url] of Object.entries(urls)) {
        if (url.length > 0) return appName;
    }
    return undefined;
}

/** The app hosting the Environment Factory handler and the path it mounts it at, as this env's config declares them. */
interface ConfiguredSdkRoles {
    appName?: string;
    /** Absent when the config declares no path, which means the convention applies. */
    path?: string;
}

/**
 * An unparsable `resolvedConfig` silently falls back to "first URL wins", which can point the SDK at an app with no
 * handler - log it so the misroute is traceable. A null config (env created before its first deploy resolved) is
 * expected and stays quiet.
 */
function sdkRolesFromConfig(resolvedConfig: unknown, environmentId: string, logger: Logger): ConfiguredSdkRoles {
    if (resolvedConfig == null) return {};
    const parsed = previewConfigSchema.safeParse(resolvedConfig);
    if (!parsed.success) {
        logger.warn("Preview environment has malformed resolvedConfig; falling back to first preview URL", {
            extra: { environmentId, issues: parsed.error.issues },
        });
        return {};
    }
    return { appName: resolveSdkAppName(parsed.data.apps), path: declaredSdkPath(parsed.data.apps) };
}

interface PreviewkitTargetInfo {
    environmentId: string;
    repoFullName: string;
    prNumber: number;
    headRef: string;
    headSha: string;
    status: string;
    error?: string;
    /** Absent while the env is still building (urls fill in at deploy time). */
    previewUrl?: string;
    sdkAppName?: string;
    /** The `sdk_path` this env's config declares, if any; absent means the convention. */
    sdkPath?: string;
    freshness: DeployFreshness;
}

function buildPreviewkitTargetInfo(
    environment: {
        id: string;
        repoFullName: string;
        prNumber: number;
        headRef: string;
        headSha: string;
        status: string;
        error: string | null;
        deployedAt: Date | null;
        urls: unknown;
        resolvedConfig: unknown;
    },
    logger: Logger,
): PreviewkitTargetInfo {
    const urls = parsePreviewUrls(environment.urls, environment.id, logger);

    const base = {
        environmentId: environment.id,
        repoFullName: environment.repoFullName,
        prNumber: environment.prNumber,
        headRef: environment.headRef,
        headSha: environment.headSha,
        status: environment.status,
        error: environment.error ?? undefined,
        freshness: deployFreshness({
            status: environment.status,
            deployedAt: environment.deployedAt ?? undefined,
        }),
    };

    const configured = sdkRolesFromConfig(environment.resolvedConfig, environment.id, logger);
    const configuredUrl = configured.appName != null ? urls[configured.appName] : undefined;
    if (configuredUrl != null && configuredUrl.length > 0) {
        return { ...base, previewUrl: configuredUrl, sdkAppName: configured.appName, sdkPath: configured.path };
    }

    // The config named no deployed app, so the app guess falls back to the first
    // deployed URL. The declared path still holds: it is a property of the
    // handler's code, not of which app we managed to resolve.
    return {
        ...base,
        previewUrl: firstPreviewUrl(urls),
        sdkAppName: firstPreviewAppName(urls),
        sdkPath: configured.path,
    };
}

/**
 * "ready" requires both a ready status and a deployed URL; a failed deploy
 * surfaces as "failed" (with the env's error), and anything in between
 * (pending/building/deploying, or ready with no URL yet) is "building".
 */
function previewkitAvailability(status: string, previewUrl: string | undefined): SdkDryRunTargetAvailability {
    if (status === "failed") return "failed";
    if (status === "ready" && previewUrl != null) return "ready";
    return "building";
}

/**
 * Lists the preview envs the Finish setup SDK validation and dry-run can run
 * against: the main env plus EVERY open PR - deployed, still building, failed,
 * or without a preview at all (each carries an `availability` explaining what
 * is actionable). Auto-detects (and flags) the SDK implementation PR by title
 * convention; the caller defaults to it but can pick any target, including main.
 */
export async function listSdkDryRunTargets(
    db: PrismaClient,
    applicationId: string,
    organizationId: string,
    vercelTargets: SdkDryRunTarget[] = [],
): Promise<SdkDryRunTargets> {
    const logger = rootLogger.child({ name: "listSdkDryRunTargets", applicationId });
    logger.info("Listing SDK dry-run targets");

    const [application, openBranches, configuredSdkPath] = await Promise.all([
        db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                githubRepositoryId: true,
                onboardingState: { select: { previewUrl: true } },
                mainBranch: {
                    select: {
                        name: true,
                        deployment: { select: { webhookUrl: true, webDeployment: { select: { url: true } } } },
                    },
                },
            },
        }),
        db.branch.findMany({
            where: { applicationId, application: { organizationId }, prInfo: { prState: "open" } },
            select: {
                name: true,
                prInfo: { select: { prNumber: true, prTitle: true } },
                deployment: { select: { webhookUrl: true, webDeployment: { select: { url: true } } } },
            },
            orderBy: { createdAt: "desc" },
        }),
        // From the LIVE config, not from each environment's resolved config: the route the handler is mounted at is
        // usually only known after the preview that serves it has already deployed, so reading the deploy-time photo
        // would make the first validation of a non-conventional endpoint fail on a path the user had already fixed.
        resolveConfiguredSdkPath(db, applicationId),
    ]);
    if (application == null) throw new NotFoundError("Application not found");

    const githubRepositoryId = application.githubRepositoryId ?? undefined;

    // "failed" stays visible so the user can see why the preview is unusable
    // (and redeploy it); only torn-down envs are gone for good. Newest-first with
    // a cap so a long-lived repo can't grow this query unbounded - stale rows past
    // the cap belong to long-closed PRs that would be filtered out anyway.
    const previewkitEnvironments =
        githubRepositoryId != null
            ? await db.previewkitEnvironment.findMany({
                  where: { organizationId, githubRepositoryId, status: { notIn: ["torn_down"] } },
                  select: {
                      id: true,
                      repoFullName: true,
                      prNumber: true,
                      urls: true,
                      headRef: true,
                      headSha: true,
                      status: true,
                      error: true,
                      deployedAt: true,
                      resolvedConfig: true,
                  },
                  orderBy: { updatedAt: "desc" },
                  take: MAX_PREVIEWKIT_ENVIRONMENTS,
              })
            : [];

    const previewkitTargetByPr = new Map<number, PreviewkitTargetInfo>();
    for (const environment of previewkitEnvironments) {
        if (!previewkitTargetByPr.has(environment.prNumber)) {
            previewkitTargetByPr.set(environment.prNumber, buildPreviewkitTargetInfo(environment, logger));
        }
    }
    const branchByPr = new Map<number, { prTitle?: string; branchName: string; deployUrl?: string; sdkUrl?: string }>();
    for (const branch of openBranches) {
        const prNumber = branch.prInfo?.prNumber;
        if (prNumber == null) continue;
        branchByPr.set(prNumber, {
            prTitle: branch.prInfo?.prTitle ?? undefined,
            branchName: branch.name,
            deployUrl: branch.deployment?.webDeployment?.url ?? undefined,
            // A split UI/API-host deployment stores its SDK endpoint separately; prefer
            // it so the dry-run hits the API host, not <deployUrl>/api/autonoma.
            sdkUrl: branch.deployment?.webhookUrl ?? undefined,
        });
    }

    const targets: SdkDryRunTarget[] = [];

    // Main env: the BYO tracked URL / PreviewKit main env / legacy main deploy.
    const mainPreviewkitTarget = previewkitTargetByPr.get(MAIN_ENVIRONMENT_PR_NUMBER);
    const mainExternalPreviewUrl =
        application.onboardingState?.previewUrl ?? application.mainBranch?.deployment?.webDeployment?.url;
    if (mainPreviewkitTarget != null) {
        targets.push({
            id: "main",
            kind: "main",
            source: "previewkit",
            label: "main",
            prNumber: MAIN_ENVIRONMENT_PR_NUMBER,
            environmentId: mainPreviewkitTarget.environmentId,
            repoFullName: mainPreviewkitTarget.repoFullName,
            sdkAppName: mainPreviewkitTarget.sdkAppName,
            status: mainPreviewkitTarget.status,
            availability: previewkitAvailability(mainPreviewkitTarget.status, mainPreviewkitTarget.previewUrl),
            error: mainPreviewkitTarget.error,
            headRef: mainPreviewkitTarget.headRef,
            headSha: mainPreviewkitTarget.headSha,
            branchName: mainPreviewkitTarget.headRef ?? application.mainBranch?.name,
            previewUrl: mainPreviewkitTarget.previewUrl,
            sdkUrl:
                mainPreviewkitTarget.previewUrl != null
                    ? buildSdkUrl(mainPreviewkitTarget.previewUrl, configuredSdkPath ?? mainPreviewkitTarget.sdkPath)
                    : undefined,
            freshness: mainPreviewkitTarget.freshness,
            requiresSharedSecretInput: false,
            isAutoDetected: false,
        });
    } else if (mainExternalPreviewUrl != null && mainExternalPreviewUrl !== "") {
        targets.push({
            id: "main",
            kind: "main",
            source: "external",
            label: "main",
            availability: "ready",
            branchName: application.mainBranch?.name,
            previewUrl: mainExternalPreviewUrl,
            // Prefer the deployment's explicit SDK endpoint (split UI/API host) over
            // the single-origin <previewUrl>/api/autonoma convention.
            sdkUrl: application.mainBranch?.deployment?.webhookUrl ?? buildSdkUrl(mainExternalPreviewUrl),
            requiresSharedSecretInput: true,
            isAutoDetected: false,
        });
    }

    const prNumbers = new Set<number>();
    for (const prNumber of previewkitTargetByPr.keys()) {
        if (prNumber !== MAIN_ENVIRONMENT_PR_NUMBER) prNumbers.add(prNumber);
    }
    for (const prNumber of branchByPr.keys()) prNumbers.add(prNumber);

    let autoDetectedTargetId: string | undefined;
    for (const prNumber of [...prNumbers].sort((a, b) => b - a)) {
        const branchInfo = branchByPr.get(prNumber);
        const previewkitTarget = previewkitTargetByPr.get(prNumber);

        const branchName = branchInfo?.branchName ?? previewkitTarget?.headRef ?? "";
        const isAutoDetected = matchesSdkConvention(branchInfo?.prTitle, branchName);
        const id = `pr-${prNumber}`;
        const label = branchInfo?.prTitle ?? (branchName !== "" ? branchName : `PR #${prNumber}`);

        if (previewkitTarget != null) {
            targets.push({
                id,
                kind: "pr",
                source: "previewkit",
                label,
                prNumber,
                environmentId: previewkitTarget.environmentId,
                repoFullName: previewkitTarget.repoFullName,
                sdkAppName: previewkitTarget.sdkAppName,
                status: previewkitTarget.status,
                availability: previewkitAvailability(previewkitTarget.status, previewkitTarget.previewUrl),
                error: previewkitTarget.error,
                headRef: previewkitTarget.headRef,
                headSha: previewkitTarget.headSha,
                branchName: branchName !== "" ? branchName : undefined,
                previewUrl: previewkitTarget.previewUrl,
                sdkUrl:
                    previewkitTarget.previewUrl != null
                        ? buildSdkUrl(previewkitTarget.previewUrl, configuredSdkPath ?? previewkitTarget.sdkPath)
                        : undefined,
                freshness: previewkitTarget.freshness,
                requiresSharedSecretInput: false,
                isAutoDetected,
            });
        } else {
            const deployUrl = branchInfo?.deployUrl;
            const hasPreview = deployUrl != null && deployUrl !== "";
            targets.push({
                id,
                kind: "pr",
                source: "external",
                label,
                prNumber,
                availability: hasPreview ? "ready" : "no_preview",
                branchName: branchName !== "" ? branchName : undefined,
                previewUrl: deployUrl,
                // Prefer the deployment's explicit SDK endpoint (split UI/API host) over
                // the single-origin <deployUrl>/api/autonoma convention.
                sdkUrl: branchInfo?.sdkUrl ?? (hasPreview ? buildSdkUrl(deployUrl) : undefined),
                requiresSharedSecretInput: hasPreview,
                isAutoDetected,
            });
        }
        // First (highest/most recent) matching PR wins the default.
        if (isAutoDetected && autoDetectedTargetId == null) autoDetectedTargetId = id;
    }

    // Vercel-linked apps validate against a Vercel deployment picked on the SDK
    // step; those deployments are their own dry-run targets (id = deployment id),
    // so the dry run points at exactly the preview the user validated.
    targets.push(...vercelTargets);

    sortTargets(targets, autoDetectedTargetId);

    logger.info("Resolved SDK dry-run targets", {
        extra: { count: targets.length, autoDetectedTargetId },
    });
    return { targets, autoDetectedTargetId };
}

/** Auto-detected SDK PR first, then main, then the remaining PRs newest-first. */
function sortTargets(targets: SdkDryRunTarget[], autoDetectedTargetId: string | undefined): void {
    function rank(target: SdkDryRunTarget): number {
        if (target.id === autoDetectedTargetId) return 0;
        if (target.kind === "main") return 1;
        return 2;
    }
    targets.sort((a, b) => rank(a) - rank(b) || (b.prNumber ?? 0) - (a.prNumber ?? 0));
}
