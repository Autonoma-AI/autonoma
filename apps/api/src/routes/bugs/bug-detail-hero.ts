import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { getStepOverlayPoints, type IssueReport, type OverlayPoint, type PrimaryScreenshot } from "@autonoma/types";
import type { LatestOccurrenceEvidence } from "./bug-detail-latest-occurrence";

const HERO_SCREENSHOT_URL_TTL_SECONDS = 3600;

interface HeroScreenshot {
    url: string;
    points: OverlayPoint[];
}

/**
 * The adaptive hero media for the bug page: the still frame that best shows the
 * bug and the run video, both resolved to signed URLs. Either may be absent - the
 * UI shows what exists (side by side when both) or a placeholder when neither.
 */
export interface HeroMedia {
    screenshot?: HeroScreenshot;
    video?: { url: string };
}

/**
 * Resolve the bug page's hero from the healing-authored report and the latest
 * occurrence's evidence. The screenshot prefers the report's designated
 * `primaryScreenshot` (signed here, pin drawn from its coordinate) and falls back
 * to the run's failing-step screenshot (already signed) with its resolved points.
 * The video is always the factual run artifact - never agent-authored.
 */
export async function buildHeroMedia(
    report: IssueReport | undefined,
    latest: LatestOccurrenceEvidence,
    storageProvider: StorageProvider,
): Promise<HeroMedia> {
    const logger = rootLogger.child({ name: "buildHeroMedia" });
    const screenshot = await resolveHeroScreenshot(report?.primaryScreenshot, latest, storageProvider, logger);
    const video = latest?.videoUrl != null ? { url: latest.videoUrl } : undefined;
    logger.info("Resolved bug hero media", {
        extra: {
            hasScreenshot: screenshot != null,
            designatedPrimary: report?.primaryScreenshot != null,
            hasVideo: video != null,
        },
    });
    return { screenshot, video };
}

async function resolveHeroScreenshot(
    primary: PrimaryScreenshot | undefined,
    latest: LatestOccurrenceEvidence,
    storageProvider: StorageProvider,
    logger: Logger,
): Promise<HeroScreenshot | undefined> {
    if (primary != null) {
        const signed = await signPrimary(primary, storageProvider, logger);
        if (signed != null) return signed;
    }
    if (latest?.failureScreenshotUrl != null) {
        return { url: latest.failureScreenshotUrl, points: getStepOverlayPoints(latest) };
    }
    return undefined;
}

/**
 * Sign the designated primary screenshot into a hero. Signing is pure URL
 * construction and never contacts storage, so it succeeds even for a pruned
 * object (that would surface as a broken image, same as the failing-step
 * fallback). The catch only guards against presigner/config errors, degrading
 * to the failing-step frame rather than failing the whole bug-detail request.
 */
async function signPrimary(
    primary: PrimaryScreenshot,
    storageProvider: StorageProvider,
    logger: Logger,
): Promise<HeroScreenshot | undefined> {
    try {
        const url = await storageProvider.getSignedUrl(primary.s3Key, HERO_SCREENSHOT_URL_TTL_SECONDS);
        const points: OverlayPoint[] =
            primary.pin != null ? [{ x: primary.pin.x, y: primary.pin.y, role: "click" }] : [];
        return { url, points };
    } catch (err) {
        logger.warn("Failed to sign primary screenshot; falling back to failing-step frame", {
            extra: { s3Key: primary.s3Key, err },
        });
        return undefined;
    }
}
