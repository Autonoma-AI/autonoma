import { logger } from "@autonoma/logger";
import { sleep } from "@autonoma/utils/sleep";
import type { Emulator } from "../emulator";
import type { DeviceDriver, PrepareDeviceOptions } from "../types";

export class IosPrepareDevice {
    constructor(private readonly emulator: Emulator) {}

    async execute(driver: DeviceDriver, options: PrepareDeviceOptions): Promise<void> {
        const { appPath, appPackage } = options;

        if (appPath == null) {
            logger.warn("No app path provided for iOS installation");
            return;
        }

        await this.dismissAlerts(driver);

        await this.waitForWDA();

        // Clear keychains to ensure clean state
        await this.clearKeychains(driver);

        // Install app
        await driver.installApp(appPath);
        logger.info(`${appPath} installed successfully`);

        if (appPackage != null) {
            await this.openApp(driver, appPackage);
        }
    }

    /**
     * Wait for WDA (WebDriverAgent) to be fully ready by polling its status endpoint.
     * Reconciled version: 120 max attempts, 1s interval, 2s timeout, 15s post-ready stabilization.
     */
    private async waitForWDA(maxAttempts = 120): Promise<void> {
        logger.info(`Waiting for WDA to be ready on port ${this.emulator.systemPort}...`);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await fetch(`http://${this.emulator.ip}:${this.emulator.systemPort}/status`, {
                    signal: AbortSignal.timeout(2000),
                });

                if (response.ok) {
                    logger.info("WDA is ready");
                    return;
                }
            } catch {
                // pass
            }

            await sleep(1000);
        }

        throw new Error(`WDA did not become ready after ${maxAttempts} attempts`);
    }

    private async waitForAppInstalled(driver: DeviceDriver, bundleId: string, maxAttempts = 30): Promise<void> {
        logger.info(`Waiting for app ${bundleId} to be registered with iOS...`);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const appState = await driver.queryAppState(bundleId);
                logger.info(`App state check (attempt ${attempt}/${maxAttempts}): ${appState}`, {
                    bundleId,
                    appState,
                });

                // appState: 0 = not installed, 1+ = installed (various running states)
                if (appState > 0) {
                    logger.info(`App ${bundleId} is now registered with iOS (state: ${appState})`);
                    return;
                }

                if (attempt % 5 === 0) {
                    logger.info(`Still waiting for app to be registered (attempt ${attempt}/${maxAttempts})...`);
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.warn(`Error checking app state (attempt ${attempt}/${maxAttempts}): ${errorMessage}`);
            }

            await sleep(1_000);
        }

        throw new Error(`App ${bundleId} was not registered with iOS after ${maxAttempts} attempts`);
    }

    private getSimulatorUdid(driver: DeviceDriver): string {
        const caps = (driver as unknown as { capabilities: Record<string, unknown> }).capabilities;
        const udid = caps["appium:udid"] ?? caps.udid;
        if (typeof udid !== "string" || udid.length === 0) {
            throw new Error("Could not determine simulator UDID from driver capabilities");
        }
        return udid;
    }

    private async dismissAlerts(driver: DeviceDriver): Promise<void> {
        try {
            await driver.execute("mobile: alert", { action: "dismiss" });
        } catch {
            // No alert present, ignore
        }
    }

    private async clearKeychains(driver: DeviceDriver): Promise<void> {
        try {
            await driver.executeScript("mobile:clearKeychains", []);
        } catch (keychainError: unknown) {
            const errorMessage = keychainError instanceof Error ? keychainError.message : String(keychainError);
            logger.warn(`Failed to clear keychains (non-fatal): ${errorMessage}`);
        }
    }

    private async openApp(driver: DeviceDriver, bundleId: string, maxAttempts = 5): Promise<void> {
        logger.info("Opening iOS app...", { bundleId });

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await driver.activateApp(bundleId);
                logger.info("Successfully opened app");
                return;
            } catch (activateError: unknown) {
                const errorMessage = activateError instanceof Error ? activateError.message : String(activateError);

                if (attempt < maxAttempts) {
                    const waitTime = attempt * 2000;
                    logger.warn(
                        `App activation failed (attempt ${attempt}/${maxAttempts}), waiting ${waitTime}ms before retry...`,
                    );
                    logger.warn(`Error details: ${errorMessage}`);
                    await sleep(waitTime);
                } else {
                    logger.error(`Failed to activate app after ${maxAttempts} attempts`);
                    throw activateError instanceof Error ? activateError : new Error(String(activateError));
                }
            }
        }
    }
}
