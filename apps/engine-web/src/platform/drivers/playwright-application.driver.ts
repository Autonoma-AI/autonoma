import type { ApplicationDriver } from "@autonoma/engine";
import { sleep } from "@autonoma/utils/sleep";
import type { ActivePageManager } from "../active-page-manager";
import { runPlaywright } from "./playwright-error";

export class PlaywrightApplicationDriver implements ApplicationDriver {
    constructor(private readonly pageManager: ActivePageManager) {}

    async waitUntilStable(timeout = 3000): Promise<void> {
        const page = this.pageManager.current;
        await runPlaywright(() => Promise.race([page.waitForLoadState("networkidle"), sleep(timeout)]));
    }
}
