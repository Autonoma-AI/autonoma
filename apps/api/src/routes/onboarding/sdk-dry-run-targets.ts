import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { previewConfigSchema } from "@autonoma/types";
import { z } from "zod";
import { buildSdkUrl } from "./sdk-url";

export type SdkDryRunTargetSource = "previewkit" | "external";

/**
 * A preview environment the SDK dry-run can target. The SDK endpoint follows the
 * fixed convention `<previewUrl>/api/autonoma`.
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
    previewUrl: string;
    sdkUrl: string;
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

/**
 * A PR is treated as the SDK implementation PR when its title (or branch) names
 * the autonoma-sdk convention, e.g. "feat: autonoma-sdk". Iterating the SDK on
 * that PR's preview env dissolves the slow push-to-main rebuild loop.
 */
function matchesSdkConvention(title: string | undefined, branchName: string): boolean {
    const haystacks = [title, branchName].filter((value): value is string => value != null);
    return haystacks.some((value) => /autonoma[-_\s]?sdk/i.test(value));
}

function parsePreviewUrls(urls: unknown): Record<string, string> | undefined {
    const parsed = PreviewUrlsSchema.safeParse(urls);
    if (!parsed.success) return undefined;
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

function sdkAppNameFromConfig(resolvedConfig: unknown): string | undefined {
    const parsed = previewConfigSchema.safeParse(resolvedConfig);
    if (!parsed.success) return undefined;
    const primary = parsed.data.apps.find((app) => app.primary === true);
    return primary?.name ?? parsed.data.apps[0]?.name;
}

interface PreviewkitTargetInfo {
    environmentId: string;
    repoFullName: string;
    prNumber: number;
    headRef: string;
    status: string;
    previewUrl: string;
    sdkAppName: string | undefined;
}

function buildPreviewkitTargetInfo(environment: {
    id: string;
    repoFullName: string;
    prNumber: number;
    headRef: string;
    status: string;
    urls: unknown;
    resolvedConfig: unknown;
}): PreviewkitTargetInfo | undefined {
    const urls = parsePreviewUrls(environment.urls);
    if (urls == null) return undefined;

    const configuredAppName = sdkAppNameFromConfig(environment.resolvedConfig);
    const configuredUrl = configuredAppName != null ? urls[configuredAppName] : undefined;
    if (configuredUrl != null && configuredUrl.length > 0) {
        return {
            environmentId: environment.id,
            repoFullName: environment.repoFullName,
            prNumber: environment.prNumber,
            headRef: environment.headRef,
            status: environment.status,
            previewUrl: configuredUrl,
            sdkAppName: configuredAppName,
        };
    }

    const fallbackUrl = firstPreviewUrl(urls);
    if (fallbackUrl == null) return undefined;

    return {
        environmentId: environment.id,
        repoFullName: environment.repoFullName,
        prNumber: environment.prNumber,
        headRef: environment.headRef,
        status: environment.status,
        previewUrl: fallbackUrl,
        sdkAppName: firstPreviewAppName(urls),
    };
}

/**
 * Lists the preview envs the Finish setup SDK dry-run can run against: every open
 * PR that has a preview env, plus the main env. Auto-detects (and flags) the SDK
 * implementation PR by title convention; the caller defaults to it but can pick
 * any target, including main.
 */
export async function listSdkDryRunTargets(
    db: PrismaClient,
    applicationId: string,
    organizationId: string,
): Promise<SdkDryRunTargets> {
    const logger = rootLogger.child({ name: "listSdkDryRunTargets", applicationId });
    logger.info("Listing SDK dry-run targets");

    const application = await db.application.findFirst({
        where: { id: applicationId, organizationId },
        select: {
            githubRepositoryId: true,
            onboardingState: { select: { previewUrl: true } },
            mainBranch: { select: { deployment: { select: { webDeployment: { select: { url: true } } } } } },
        },
    });
    if (application == null) throw new NotFoundError("Application not found");

    const githubRepositoryId = application.githubRepositoryId ?? undefined;

    const previewkitEnvironments =
        githubRepositoryId != null
            ? await db.previewkitEnvironment.findMany({
                  where: { organizationId, githubRepositoryId, status: { notIn: ["torn_down", "failed"] } },
                  select: {
                      id: true,
                      repoFullName: true,
                      prNumber: true,
                      urls: true,
                      headRef: true,
                      status: true,
                      resolvedConfig: true,
                  },
                  orderBy: { updatedAt: "desc" },
              })
            : [];

    const previewkitTargetByPr = new Map<number, PreviewkitTargetInfo>();
    for (const environment of previewkitEnvironments) {
        if (!previewkitTargetByPr.has(environment.prNumber)) {
            const targetInfo = buildPreviewkitTargetInfo(environment);
            if (targetInfo != null) previewkitTargetByPr.set(environment.prNumber, targetInfo);
        }
    }

    const openBranches = await db.branch.findMany({
        where: { applicationId, application: { organizationId }, prInfo: { prState: "open" } },
        select: {
            name: true,
            prInfo: { select: { prNumber: true, prTitle: true } },
            deployment: { select: { webDeployment: { select: { url: true } } } },
        },
        orderBy: { createdAt: "desc" },
    });
    const branchByPr = new Map<number, { prTitle?: string; branchName: string; deployUrl?: string }>();
    for (const branch of openBranches) {
        const prNumber = branch.prInfo?.prNumber;
        if (prNumber == null) continue;
        branchByPr.set(prNumber, {
            prTitle: branch.prInfo?.prTitle ?? undefined,
            branchName: branch.name,
            deployUrl: branch.deployment?.webDeployment?.url ?? undefined,
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
            previewUrl: mainPreviewkitTarget.previewUrl,
            sdkUrl: buildSdkUrl(mainPreviewkitTarget.previewUrl),
            requiresSharedSecretInput: false,
            isAutoDetected: false,
        });
    } else if (mainExternalPreviewUrl != null && mainExternalPreviewUrl !== "") {
        targets.push({
            id: "main",
            kind: "main",
            source: "external",
            label: "main",
            previewUrl: mainExternalPreviewUrl,
            sdkUrl: buildSdkUrl(mainExternalPreviewUrl),
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
        const previewUrl = previewkitTarget?.previewUrl ?? branchInfo?.deployUrl;
        if (previewUrl == null || previewUrl === "") continue;

        const branchName = branchInfo?.branchName ?? previewkitTarget?.headRef ?? "";
        const isAutoDetected = matchesSdkConvention(branchInfo?.prTitle, branchName);
        const id = `pr-${prNumber}`;
        targets.push({
            id,
            kind: "pr",
            source: previewkitTarget != null ? "previewkit" : "external",
            label: branchInfo?.prTitle ?? (branchName !== "" ? branchName : `PR #${prNumber}`),
            prNumber,
            environmentId: previewkitTarget?.environmentId,
            repoFullName: previewkitTarget?.repoFullName,
            sdkAppName: previewkitTarget?.sdkAppName,
            status: previewkitTarget?.status,
            previewUrl,
            sdkUrl: buildSdkUrl(previewUrl),
            requiresSharedSecretInput: previewkitTarget == null,
            isAutoDetected,
        });
        // First (highest/most recent) matching PR wins the default.
        if (isAutoDetected && autoDetectedTargetId == null) autoDetectedTargetId = id;
    }

    logger.info("Resolved SDK dry-run targets", {
        extra: { count: targets.length, autoDetectedTargetId },
    });
    return { targets, autoDetectedTargetId };
}
