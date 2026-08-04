import type { KeyboardDriver, TypeOptions } from "@autonoma/engine";
import type { Browser } from "webdriverio";
import { runAppium } from "./appium-error";

const KEYCODE_A = 29;
const KEYCODE_DEL = 67;
const META_CTRL_ON = 4096;

export class AndroidKeyboardDriver implements KeyboardDriver {
    constructor(private readonly driver: Browser) {}

    async pressKey(keycode: number, metastate?: number): Promise<void> {
        await runAppium(() =>
            this.driver.executeScript("mobile: pressKey", [{ keycode, ...(metastate != null && { metastate }) }]),
        );
    }

    async selectAll(): Promise<void> {
        await this.pressKey(KEYCODE_A, META_CTRL_ON);
    }

    async clear(): Promise<void> {
        await this.selectAll();
        await this.pressKey(KEYCODE_DEL, META_CTRL_ON);
    }

    async type(text: string, options?: TypeOptions): Promise<void> {
        if (options?.overwrite === true) await this.selectAll();

        await runAppium(() => this.driver.keys(text));
    }

    async press(key: string): Promise<void> {
        await runAppium(() => this.driver.keys(key));
    }
}
