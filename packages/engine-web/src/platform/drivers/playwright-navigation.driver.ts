import type { NavigationDriver } from "@autonoma/engine";
import { type Logger, logger } from "@autonoma/logger";
import type { ActivePageManager } from "../active-page-manager";
import { runPlaywright } from "./playwright-error";

export class PlaywrightNavigationDriver implements NavigationDriver {
    private readonly logger: Logger;

    constructor(private readonly pageManager: ActivePageManager) {
        this.logger = logger.child({ name: "PlaywrightNavigationDriver" });
    }

    async navigate(url: string): Promise<void> {
        const page = this.pageManager.current;
        this.logger.info("Navigating to URL", { targetUrl: url, currentUrl: page.url() });
        await runPlaywright(() => page.goto(url, { waitUntil: "domcontentloaded" }));
    }

    async getCurrentUrl(): Promise<string> {
        return this.pageManager.current.url();
    }

    async refresh(): Promise<void> {
        const page = this.pageManager.current;
        this.logger.info("Refreshing the page", { currentUrl: page.url() });
        await runPlaywright(() => page.reload({ waitUntil: "domcontentloaded" }));
    }
}
