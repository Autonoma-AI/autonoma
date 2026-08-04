import type { ScreenResolution } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import { chromium } from "playwright";

const logger = rootLogger.child({ name: "ConnectRemoteBrowser" });

interface RemoteBrowserOptions {
    remoteChromeEndpoint: string;
    viewport: ScreenResolution;
}

export class ConnectBrowserError extends Error {
    constructor(cause: Error) {
        super(`Failed to connect to remote browser: ${cause.message}`, { cause });
    }
}

export async function connectRemoteBrowser({ remoteChromeEndpoint, viewport }: RemoteBrowserOptions) {
    const launchOptions = {
        args: [
            `--window-size=${viewport.width},${viewport.height}`,
            "--window-position=0,0",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--allow-file-access-from-files",
        ],
    };

    const wsUrl = `ws://${remoteChromeEndpoint}/chrome/playwright?timeout=3600000&launch=${JSON.stringify(launchOptions)}`;
    logger.info("Connecting to remote browser", { endpoint: remoteChromeEndpoint, viewport });

    try {
        const browser = await chromium.connect(wsUrl);
        logger.info("Successfully connected to remote browser", {
            endpoint: remoteChromeEndpoint,
            browserVersion: browser.version(),
        });
        return browser;
    } catch (error) {
        logger.error("Failed to connect to remote browser", error, { endpoint: remoteChromeEndpoint });
        throw new ConnectBrowserError(error as Error);
    }
}
