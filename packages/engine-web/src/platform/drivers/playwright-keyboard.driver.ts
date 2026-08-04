import type { KeyboardDriver, TypeOptions } from "@autonoma/engine";
import type { ActivePageManager } from "../active-page-manager";
import { runPlaywright } from "./playwright-error";

export class PlaywrightKeyboardDriver implements KeyboardDriver {
    constructor(private readonly pageManager: ActivePageManager) {}

    async selectAll(): Promise<void> {
        await runPlaywright(() => this.pageManager.current.keyboard.press("ControlOrMeta+A"));
    }

    async clear(): Promise<void> {
        await runPlaywright(async () => {
            await this.selectAll();
            await this.pageManager.current.keyboard.press("Backspace");
        });
    }

    async type(text: string, options?: TypeOptions): Promise<void> {
        if (options?.overwrite === true) await this.selectAll();

        await runPlaywright(() => this.pageManager.current.keyboard.type(text));
    }

    async press(key: string): Promise<void> {
        await runPlaywright(() => this.pageManager.current.keyboard.press(key));
    }
}
