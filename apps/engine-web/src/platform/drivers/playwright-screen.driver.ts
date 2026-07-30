import type { ScreenDriver } from "@autonoma/engine";
import { type ScreenResolution, Screenshot } from "@autonoma/image";
import { type Logger, logger } from "@autonoma/logger";
import type { ActivePageManager } from "../active-page-manager";
import type { CursorOverlay } from "../cursor-overlay";
import { PlaywrightError, runPlaywright } from "./playwright-error";

export class PlaywrightScreenDriver implements ScreenDriver {
    private readonly logger: Logger;

    constructor(
        private readonly pageManager: ActivePageManager,
        private readonly cursor?: CursorOverlay,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async getResolution(): Promise<ScreenResolution> {
        const viewportSize = this.pageManager.current.viewportSize();
        if (viewportSize == null) throw new PlaywrightError(new Error("Viewport size is null"));
        return { width: viewportSize.width, height: viewportSize.height };
    }

    async screenshot(): Promise<Screenshot> {
        this.logger.info("Taking Playwright screenshot...");

        // The synthetic pointer belongs to the video only - see CursorOverlay.setVisible.
        await this.cursor?.setVisible(false);
        try {
            const buffer = await runPlaywright(() =>
                this.pageManager.current.screenshot({ type: "jpeg", quality: 90 }),
            );
            this.logger.info("Playwright screenshot taken", { bufferSize: buffer.length });
            return Screenshot.fromBuffer(buffer);
        } finally {
            await this.cursor?.setVisible(true);
        }
    }
}
