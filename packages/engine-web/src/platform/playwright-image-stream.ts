import type { ImageStream } from "@autonoma/engine";
import { type Logger, logger } from "@autonoma/logger";
import type { CDPSession } from "playwright";
import type { ActivePageManager } from "./active-page-manager";

/**
 * Playwright implementation of ImageStream using CDP screencast for real-time frame capture.
 *
 * This implementation uses Chrome DevTools Protocol (CDP) to capture screen frames
 * as JPEG images and provides them to registered frame handlers.
 *
 * When the active page changes (e.g. a new tab opens), the screencast is automatically
 * restarted on the new page so the stream always reflects what the agent is acting on.
 */
export class PlaywrightImageStream implements ImageStream {
    private readonly logger: Logger;
    private session: CDPSession | null = null;
    private frameHandlers: Array<(image: string) => void | Promise<void>> = [];

    constructor(private readonly pageManager: ActivePageManager) {
        this.logger = logger.child({
            name: "PlaywrightImageStream",
        });

        pageManager.onPageChange((page) => {
            this.logger.info("Active page changed, restarting screencast", { url: page.url() });
            this.restart().catch((err) => this.logger.error("Failed to restart screencast after page change", err));
        });
    }

    /**
     * Register a callback to receive frame data as Buffer.
     * Multiple handlers can be registered and will all receive frames.
     */
    public addFrameHandler(callback: (image: string) => void | Promise<void>): void {
        this.frameHandlers.push(callback);
        this.logger.debug("Frame handler registered", {
            totalHandlers: this.frameHandlers.length,
        });
    }

    /**
     * Start the screencast and begin capturing frames.
     */
    public async start(): Promise<void> {
        if (this.session != null) {
            this.logger.warn("Stream already started");
            return;
        }

        this.logger.info("Creating CDP session for screencast");
        const page = this.pageManager.current;
        this.session = await page.context().newCDPSession(page);
        this.logger.info("CDP session created successfully");

        // Set up the screencast frame handler
        this.session.on("Page.screencastFrame", async ({ data, sessionId }) => {
            for (const handler of this.frameHandlers) handler(data);

            await this.session?.send("Page.screencastFrameAck", { sessionId });
        });

        // Start the screencast
        this.logger.info("Starting Page.startScreencast");
        await this.session.send("Page.startScreencast", {
            format: "jpeg",
            quality: 80,
            everyNthFrame: 1,
        });

        this.logger.info("Started image stream successfully");
    }

    /**
     * Stop the screencast and clean up resources.
     */
    public async stop(): Promise<void> {
        this.logger.info("Stopping image stream");

        if (this.session == null) {
            this.logger.warn("Image stream not started");
            return;
        }

        try {
            await this.session.send("Page.stopScreencast");
            this.logger.info("Screencast stopped");
        } catch (error) {
            this.logger.error("Error stopping screencast", error);
        }

        try {
            await this.session.detach();
            this.logger.info("CDP session detached");
        } catch (error) {
            this.logger.error("Error detaching CDP session", error);
        }

        this.session = null;
    }

    private async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }
}
