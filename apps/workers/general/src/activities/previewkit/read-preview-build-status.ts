import { db, PreviewkitAppStatus, PreviewkitStatus } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { AppRole } from "@autonoma/types";
import {
    isPrimaryAppAmbiguous,
    isSdkAppAmbiguous,
    parseStringRecord,
    projectManifest,
    resolvePrimaryAppName,
    resolvePrimaryUrl,
    resolveSdkAppName,
    resolveSdkAppUrl,
} from "@autonoma/types";
import type {
    PreviewBuildState,
    ReadPreviewBuildStatusInput,
    ReadPreviewBuildStatusOutput,
} from "@autonoma/workflow/activities";

const logger = rootLogger.child({ name: "readPreviewBuildStatus" });

/**
 * Two rows, because they answer different halves. The ENVIRONMENT row is per (repo, PR) and carries only the deploy
 * currently owning it - it can say "our build is live" but not "our build lost". The BUILD row is per commit.
 */
export async function readPreviewBuildStatus(
    input: ReadPreviewBuildStatusInput,
): Promise<ReadPreviewBuildStatusOutput> {
    const { repoFullName, prNumber, headSha } = input;

    const environment = await db.previewkitEnvironment.findUnique({
        where: { repoFullName_prNumber: { repoFullName, prNumber } },
        select: {
            id: true,
            organizationId: true,
            headSha: true,
            status: true,
            error: true,
            urls: true,
            resolvedConfig: true,
            appInstances: { select: { appName: true, status: true, url: true } },
        },
    });

    if (environment == null) {
        return { state: "missing" };
    }

    if (environment.headSha !== headSha) {
        return await readForeignHead({ environmentId: environment.id, repoFullName, prNumber, headSha });
    }

    const state = mapEnvironmentStatus(environment.status);
    if (state !== "ready") {
        return { state, error: environment.error ?? undefined };
    }

    const manifest = projectManifest(environment.resolvedConfig);
    const urls = browsableUrls(environment.appInstances, parseStringRecord(environment.urls));
    logger.info("Preview environment is ready", {
        preview: { repo: repoFullName },
        extra: { pr: prNumber, browsableAppCount: Object.keys(urls).length },
    });

    reportGuessedAppRoles({
        apps: manifest.apps ?? [],
        organizationId: environment.organizationId,
        repoFullName,
        prNumber,
    });

    const primaryUrl = resolvePrimaryUrl(manifest, urls);
    // An environment can reach `ready` with a constituent app broken, so a missing primary URL usually means the app
    // the tests browse never built - not that the preview is fine but nameless. Say which, because the caller can
    // only report that no URL exists.
    const error =
        primaryUrl == null ? describeMissingPrimary(manifest.apps ?? [], environment.appInstances) : undefined;

    return { state: "ready", primaryUrl, error, sdkAppUrl: resolveSdkAppUrl(manifest, urls) };
}

/**
 * The `urls` blob holds an entry for every app not SKIPPED, so a failed deploy leaves the hostname it would have
 * had. The per-app rows carry the verdict, so they decide. Environments predating those rows fall back to the blob.
 */
function browsableUrls(
    instances: readonly { appName: string; status: PreviewkitAppStatus; url: string | null }[],
    stored: Record<string, string>,
): Record<string, string> {
    if (instances.length === 0) return stored;

    const urls: Record<string, string> = {};
    for (const instance of instances) {
        if (instance.status !== PreviewkitAppStatus.ready) continue;
        // A ready row should carry its own URL; the blob is a fallback for rows written without one.
        const url = instance.url ?? stored[instance.appName];
        if (url != null && url !== "") urls[instance.appName] = url;
    }
    return urls;
}

const FAILED_APP_STATUSES: ReadonlySet<PreviewkitAppStatus> = new Set([
    PreviewkitAppStatus.build_failed,
    PreviewkitAppStatus.deploy_failed,
]);

/** An environment reaches `ready` with a constituent app broken (#2063). Name the app, not just the absence. */
function describeMissingPrimary(
    apps: readonly AppRole[],
    instances: readonly { appName: string; status: PreviewkitAppStatus }[],
): string {
    const primaryApp = resolvePrimaryAppName(apps);
    if (primaryApp == null) return "the preview declares no apps";

    const instance = instances.find((row) => row.appName === primaryApp);
    if (instance == null) return `the primary app \`${primaryApp}\` never deployed`;
    if (FAILED_APP_STATUSES.has(instance.status)) {
        return `the primary app \`${primaryApp}\` ${instance.status.replace("_", " ")}`;
    }
    return `the primary app \`${primaryApp}\` is ${instance.status} but exposes no URL`;
}

/**
 * FATAL because a wrong guess is billed as a real run and nothing downstream can tell it from a genuine result.
 * Separate messages: a config can declare `primary` and omit `sdk_implemented`, and the two are fixed apart. #2062.
 */
function reportGuessedAppRoles(params: {
    apps: AppRole[];
    organizationId: string;
    repoFullName: string;
    prNumber: number;
}): void {
    const { apps, organizationId, repoFullName, prNumber } = params;
    const ids = { organization: { organizationId }, preview: { repo: repoFullName } };
    const declaredApps = apps.map((app) => app.name);

    if (isPrimaryAppAmbiguous(apps)) {
        logger.fatal("Preview has several apps and none is marked primary; guessing which one the tests browse", {
            ...ids,
            extra: { pr: prNumber, guessedApp: resolvePrimaryAppName(apps), declaredApps },
        });
    }

    if (isSdkAppAmbiguous(apps)) {
        logger.fatal("Preview has several apps and none is marked sdk_implemented; guessing where setup calls go", {
            ...ids,
            extra: { pr: prNumber, guessedApp: resolveSdkAppName(apps), declaredApps },
        });
    }
}

/** Either "ours has not claimed it yet" or "ours already lost" - only our own build row tells them apart. */
async function readForeignHead(params: {
    environmentId: string;
    repoFullName: string;
    prNumber: number;
    headSha: string;
}): Promise<ReadPreviewBuildStatusOutput> {
    const { environmentId, repoFullName, prNumber, headSha } = params;

    const build = await db.previewkitBuild.findUnique({
        where: { environmentId_headSha: { environmentId, headSha } },
        select: { status: true, error: true },
    });

    if (build == null || build.status === PreviewkitStatus.pending || build.status === PreviewkitStatus.building) {
        logger.info("Preview environment has not been claimed by this build yet", {
            preview: { repo: repoFullName },
            extra: { pr: prNumber, waitingFor: headSha, buildStatus: build?.status },
        });
        return { state: "missing" };
    }

    // A terminal build row at our head while the environment sits elsewhere means a newer deploy took over. A
    // `failed` row that lost the environment is the same outcome for this commit: no preview is coming.
    logger.info("Preview build for this commit was superseded by a newer deploy", {
        preview: { repo: repoFullName },
        extra: { pr: prNumber, headSha, buildStatus: build.status },
    });
    return { state: "superseded", error: build.error ?? undefined };
}

function mapEnvironmentStatus(status: PreviewkitStatus): PreviewBuildState {
    switch (status) {
        case PreviewkitStatus.ready:
            return "ready";
        // `torn_down` is a failure for the waiter's purposes: the PR closed mid-build, so no preview is coming.
        case PreviewkitStatus.failed:
        case PreviewkitStatus.torn_down:
            return "failed";
        // Still in flight as far as the environment row is concerned. `superseded` is only ever written to a build
        // row, so an environment carrying it would be a data anomaly - waiting it out is the safe reading.
        case PreviewkitStatus.pending:
        case PreviewkitStatus.building:
        case PreviewkitStatus.deploying:
        case PreviewkitStatus.superseded:
            return "building";
    }
}
