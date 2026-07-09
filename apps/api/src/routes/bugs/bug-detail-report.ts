import { logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { extractEvidenceAssetIds, type IssueReport, type OverlayPoint, type SuspectedCause } from "@autonoma/types";

const SIGNED_URL_TTL_SECONDS = 3600;

/** One narrative-embedded asset resolved for the client: a short-lived URL, never the raw s3Key. */
interface ResolvedEvidenceAsset {
    assetId: string;
    url: string;
    kind: "screenshot" | "step_output";
    pin?: OverlayPoint;
}

/**
 * The client-facing report: the healing-authored text core plus the resolved
 * evidence the narrative references. `evidence` replaces the internal
 * `evidenceManifest` (whose `s3Key`s never leave the server); the UI looks each
 * `evidence:<assetId>` token up here and renders the image, or nothing when the
 * token has no resolved asset. `suspectedCause` is passed through unchanged - the
 * bug page renders it as prose in its own hedged, subordinate section.
 * `primaryScreenshot` is deliberately omitted: it is a hero-only input resolved
 * into a signed URL before the client ever sees it, not something this section
 * renders.
 */
export interface ResolvedBugReport {
    expectedBehavior?: string;
    actualBehavior: string;
    narrativeMarkdown: string;
    evidence: ResolvedEvidenceAsset[];
    suspectedCause?: SuspectedCause;
}

/**
 * Resolve a persisted `Issue.report` into its client-facing shape: sign the
 * s3Keys of every manifest asset the narrative actually references into
 * short-lived URLs. Only referenced tokens are resolved (the narrative is the
 * source of truth for what renders), and a token whose asset is missing or whose
 * URL cannot be signed simply resolves to nothing - the UI never shows a broken
 * image. Returns undefined for occurrences with no report.
 */
export async function buildBugReportDetail(
    report: IssueReport | undefined,
    storageProvider: StorageProvider,
): Promise<ResolvedBugReport | undefined> {
    if (report == null) return undefined;
    const logger = rootLogger.child({ name: "buildBugReportDetail" });

    const manifest = report.evidenceManifest ?? [];
    const referencedIds = new Set(extractEvidenceAssetIds(report.narrativeMarkdown));
    const referenced = manifest.filter((asset) => referencedIds.has(asset.assetId));

    const resolved = await Promise.all(
        referenced.map(async (asset): Promise<ResolvedEvidenceAsset | undefined> => {
            try {
                const url = await storageProvider.getSignedUrl(asset.s3Key, SIGNED_URL_TTL_SECONDS);
                return { assetId: asset.assetId, url, kind: asset.kind, pin: asset.pin };
            } catch (err) {
                logger.warn("Failed to sign evidence asset; its token will render as nothing", {
                    extra: { assetId: asset.assetId, err },
                });
                return undefined;
            }
        }),
    );
    const evidence = resolved.filter((asset): asset is ResolvedEvidenceAsset => asset != null);

    logger.info("Resolved bug report evidence", {
        extra: { manifestCount: manifest.length, referencedCount: referenced.length, resolvedCount: evidence.length },
    });

    return {
        expectedBehavior: report.expectedBehavior,
        actualBehavior: report.actualBehavior,
        narrativeMarkdown: report.narrativeMarkdown,
        evidence,
        suspectedCause: report.suspectedCause,
    };
}
