import type { ScreenDriver } from "@autonoma/engine";
import type { ScreenResolution, Screenshot } from "@autonoma/image";
import { Screenshot as ScreenshotClass } from "@autonoma/image";
import { logger } from "@autonoma/logger";
import type { Browser } from "webdriverio";
import type { AppiumImageStream } from "../appium-image-stream";
import { runAppium } from "./appium-error";

export class AppiumScreenDriver implements ScreenDriver {
    private readonly logger = logger.child({ name: this.constructor.name });

    constructor(
        private readonly driver: Browser,
        private readonly imageStream?: AppiumImageStream,
    ) {}

    async getResolution(): Promise<ScreenResolution> {
        return runAppium(() => this.driver.getWindowSize());
    }

    async screenshot(): Promise<Screenshot> {
        this.logger.info("Taking Appium screenshot...");

        if (this.imageStream != null) {
            const cachedFrame = this.imageStream.getLastImage();

            if (cachedFrame != null) {
                this.logger.info("Using cached frame from MJPEG stream");
                return ScreenshotClass.fromBuffer(cachedFrame);
            }
        }

        this.logger.info("No fresh cached frame available, falling back to driver screenshot");

        const screenshotBase64 = await runAppium(() => this.driver.takeScreenshot());

        this.logger.info("Appium screenshot taken");

        return ScreenshotClass.fromBase64(screenshotBase64);
    }
}
