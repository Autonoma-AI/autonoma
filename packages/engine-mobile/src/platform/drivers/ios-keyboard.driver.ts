import type { KeyboardDriver, TypeOptions } from "@autonoma/engine";
import type { Browser } from "webdriverio";
import { runAppium } from "./appium-error";

type ElementReference = Record<"element-6066-11e4-a52e-4f735466cecf", string>;

export class IosKeyboardDriver implements KeyboardDriver {
    constructor(private readonly driver: Browser) {}

    private async getActiveElement() {
        const ref = await this.driver.getActiveElement();
        return this.driver.$(ref as ElementReference);
    }

    async selectAll(): Promise<void> {
        await runAppium(async () => {
            const activeElement = await this.getActiveElement();
            await activeElement.setValue("");
        });
    }

    async clear(): Promise<void> {
        await runAppium(async () => {
            const activeElement = await this.getActiveElement();
            await activeElement.clearValue();
        });
    }

    async type(text: string, options?: TypeOptions): Promise<void> {
        if (options?.overwrite === true) await this.clear();

        const keys = [...text];
        await runAppium(() => this.driver.executeScript("mobile: keys", [{ keys }]));
    }

    async press(key: string): Promise<void> {
        await runAppium(() => this.driver.executeScript("mobile: keys", [{ keys: [key] }]));
    }
}
