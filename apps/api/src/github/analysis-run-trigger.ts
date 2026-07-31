import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import { buildSdkUrl } from "@autonoma/test-updates";
import { resolvePrimaryAppName, resolveSdkAppName } from "@autonoma/types";
import { z } from "zod";
import type { DiffsTriggerService } from "../diffs/diffs-trigger.service";
import type { RepoPrRef } from "./merge-gate.service";

/** The repo + PR to fire a run for. */
export type RequestRunParams = RepoPrRef;

/**
 * Why a requested run did not start, so the caller can tell the requester something actionable: `no_preview` when
 * the PR has no live preview to seed the run from; `already_analyzed` when the current head was already analyzed
 * and there is nothing new to diff.
 */
export type RunNotStartedReason = "no_preview" | "already_analyzed";

export interface RequestRunOutcome {
    started: boolean;
    /** The reason a run could not begin, if `started` is false. */
    reason?: RunNotStartedReason;
}

/**
 * Fires the analysis run a merge-gate trigger asked for - the same run preview-ready starts automatically, but
 * requested on demand. Returns whether a run was
 * actually started and, when not, why (a no-op when there is nothing new to analyze).
 */
export interface AnalysisRunTrigger {
    requestRun(params: RequestRunParams): Promise<RequestRunOutcome>;
}

/** Minimal projection of a preview environment's resolved config: the apps, which is primary, and which hosts the SDK. */
const resolvedConfigAppsSchema = z.object({
    apps: z.array(
        z.object({
            name: z.string(),
            primary: z.boolean().nullish(),
            sdk_implemented: z.boolean().nullish(),
        }),
    ),
});

/** The `urls` JSON column is an appName -> URL map. */
const urlsSchema = z.record(z.string(), z.string());

/** The DiffsTriggerService surface this needs - only the PR trigger. */
type PrDiffsTrigger = Pick<DiffsTriggerService, "triggerPrDiffs">;

/**
 * Production {@link AnalysisRunTrigger}: resolves the PR's live preview URL (the primary app of its PreviewKit
 * environment) and starts the run through the shared {@link DiffsTriggerService}, marking it `requested: true` so
 * it bypasses the org's activation gate. The preview itself was deployed automatically on PR open; only the
 * analysis run is gated behind activation, so the URL is already there to seed the run from.
 */
export class PreviewAnalysisRunTrigger implements AnalysisRunTrigger {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly diffsTrigger: PrDiffsTrigger,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async requestRun(params: RequestRunParams): Promise<RequestRunOutcome> {
        this.logger.info("Requesting analysis run", {
            organizationId: params.organizationId,
            extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
        });

        const targets = await this.resolvePreviewTargets(params);
        if (targets == null) {
            this.logger.warn("No preview URL for PR; cannot start the requested analysis run", {
                organizationId: params.organizationId,
                extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
            });
            return { started: false, reason: "no_preview" };
        }

        const result = await this.diffsTrigger.triggerPrDiffs({
            organizationId: params.organizationId,
            repoId: params.githubRepositoryId,
            prNumber: params.prNumber,
            url: targets.url,
            webhookUrl: buildSdkUrl(targets.sdkAppUrl ?? targets.url),
            requested: true,
        });

        const started = result.skipped !== true;
        this.logger.info("Requested analysis run resolved", {
            organizationId: params.organizationId,
            extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, started },
        });
        if (started) return { started: true };
        // A skip here can only mean the head was already analyzed: we pass `requested: true`, which bypasses the
        // activation gate in DiffsRunPreparer.prepare, so the sole remaining skip path is head === base (no new
        // commits).
        return { started: false, reason: "already_analyzed" };
    }

    /**
     * The preview origins the requested run needs, or undefined when no live preview environment resolves:
     * - `url` - the primary app's origin, what the run seeds and tests against.
     * - `sdkAppUrl` - the origin of the app hosting the Environment Factory handler (the `sdk_implemented` app,
     *   falling back to the primary), from which the scenario up/down endpoint is derived.
     */
    private async resolvePreviewTargets(
        params: RequestRunParams,
    ): Promise<{ url: string; sdkAppUrl?: string } | undefined> {
        const logContext = {
            organizationId: params.organizationId,
            extra: { repoFullName: params.repoFullName, prNumber: params.prNumber },
        };

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: {
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                organizationId: params.organizationId,
                status: { not: "torn_down" },
            },
            orderBy: { createdAt: "desc" },
            select: { urls: true, resolvedConfig: true },
        });
        if (environment == null) {
            this.logger.warn("No live preview environment for PR; cannot resolve a preview URL", logContext);
            return undefined;
        }

        const urls = urlsSchema.safeParse(environment.urls);
        if (!urls.success) {
            this.logger.warn("Preview environment has malformed `urls`; cannot resolve a preview URL", logContext);
            return undefined;
        }

        const parsedApps = resolvedConfigAppsSchema.safeParse(environment.resolvedConfig);
        if (!parsedApps.success) {
            this.logger.warn(
                "Preview environment has malformed `resolvedConfig`; falling back to first URL",
                logContext,
            );
        }
        const apps = parsedApps.success ? parsedApps.data.apps : [];

        const primaryName = resolvePrimaryAppName(apps);
        const url = (primaryName != null ? urls.data[primaryName] : undefined) ?? Object.values(urls.data)[0];
        if (url == null) {
            this.logger.warn("Preview environment has no resolvable URL", logContext);
            return undefined;
        }

        const sdkAppName = resolveSdkAppName(apps);
        const sdkAppUrl = sdkAppName != null ? urls.data[sdkAppName] : undefined;
        return { url, sdkAppUrl };
    }
}
