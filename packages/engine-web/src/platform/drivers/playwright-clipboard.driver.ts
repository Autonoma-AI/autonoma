import type { ClipboardDriver } from "@autonoma/engine";
import { type Logger, logger } from "@autonoma/logger";
import type { ActivePageManager } from "../active-page-manager";
import { runPlaywright } from "./playwright-error";

export class PlaywrightClipboardDriver implements ClipboardDriver {
    private readonly logger: Logger;

    constructor(private readonly pageManager: ActivePageManager) {
        this.logger = logger.child({ name: "PlaywrightClipboardDriver" });
    }

    async read(): Promise<string> {
        this.logger.info("Reading clipboard content");
        const text = await runPlaywright(() => this.pageManager.current.evaluate(() => navigator.clipboard.readText()));
        this.logger.info("Clipboard content read", { text });
        return text;
    }
}
