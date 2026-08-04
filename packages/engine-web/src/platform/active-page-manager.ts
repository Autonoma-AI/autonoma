import { type Logger, logger } from "@autonoma/logger";
import type { BrowserContext, Page } from "playwright";

/**
 * Tracks the active Playwright page across the browser context.
 *
 * When a new page opens (window.open, target="_blank", etc.), it automatically
 * becomes the active page. When a page closes, the most recently opened
 * remaining page becomes active.
 */
export class ActivePageManager {
    private pages: Page[] = [];
    private readonly logger: Logger;
    private readonly pageChangeHandlers: Array<(page: Page) => void> = [];

    constructor(initialPage: Page, context: BrowserContext) {
        this.logger = logger.child({ name: "ActivePageManager" });

        this.track(initialPage);

        context.on("page", (page) => {
            this.logger.info("New page opened, switching active page");
            this.track(page);
            for (const handler of this.pageChangeHandlers) handler(page);
        });
    }

    get current(): Page {
        const page = this.pages[this.pages.length - 1];
        if (page == null) throw new Error("No active page");
        return page;
    }

    onPageChange(handler: (page: Page) => void): void {
        this.pageChangeHandlers.push(handler);
    }

    private track(page: Page): void {
        this.pages.push(page);
        page.on("close", () => {
            this.logger.info("Page closed, reverting to previous active page");
            this.pages = this.pages.filter((p) => p !== page);
        });
    }
}
