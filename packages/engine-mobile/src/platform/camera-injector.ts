import { readFileSync } from "node:fs";
import { type Logger, logger } from "@autonoma/logger";
import type { Browser } from "webdriverio";

export interface CameraInjector {
    inject(driver: Browser, photoPath: string): Promise<void>;
}

export class IosCameraInjector implements CameraInjector {
    private readonly logger: Logger;

    constructor() {
        this.logger = logger.child({ name: "IosCameraInjector" });
    }

    async inject(_driver: Browser, _photoPath: string): Promise<void> {
        return;
    }

    private getSimulatorUdid(driver: Browser): string {
        const caps = driver.capabilities as Record<string, unknown>;
        const udid = caps["appium:udid"] ?? caps.udid;
        if (typeof udid !== "string" || udid.length === 0) {
            throw new Error("Cannot inject iOS camera image: could not determine simulator UDID");
        }
        return udid;
    }
}

export class AndroidCameraInjector implements CameraInjector {
    async inject(driver: Browser, photoPath: string): Promise<void> {
        const base64 = readFileSync(photoPath).toString("base64");
        await driver.executeScript("mobile: injectEmulatorCameraImage", [{ payload: base64 }]);
    }
}
