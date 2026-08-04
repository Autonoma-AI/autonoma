import { type Logger, logger } from "@autonoma/logger";
import type { Browser } from "webdriverio";
import { isBasePackage, listInstalledApps, updateDateOnDevice } from "./device-helpers";

/**
 * Simplified Android emulator configurator.
 * Handles app installation and activation.
 */
export class AndroidEmulatorConfigurator {
    private readonly logger: Logger;

    constructor() {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async installAndActivateApp(
        driver: Browser,
        downloadUrl: string,
        apkPackage?: string,
        removeBeforeInstall?: boolean,
    ): Promise<void> {
        this.logger.info("Installing app", { downloadUrl: `${downloadUrl.substring(0, 100)}...` });

        await driver.executeScript("mobile: shell", [{ command: "svc wifi disable" }]);

        if (removeBeforeInstall) {
            await this.removeExistingApp(driver, apkPackage);
        }

        this.logger.info("Enabling wifi...");
        await driver.executeScript("mobile: shell", [{ command: "svc wifi enable" }]);

        await driver.installApp(downloadUrl);
        this.logger.info("App installed successfully");

        if (apkPackage != null) {
            this.logger.info("Activating app", { apkPackage });
            await driver.activateApp(apkPackage);
            this.logger.info("App activated successfully");
        } else {
            this.logger.info("No package name provided, finding and activating installed app");
            await this.openInstalledApp(driver, undefined);
        }

        try {
            await updateDateOnDevice(driver, this.logger);
        } catch (error) {
            this.logger.warn("Failed to update device date", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async removeExistingApp(driver: Browser, apkPackage?: string): Promise<void> {
        if (apkPackage != null) {
            const isInstalled = await driver.isAppInstalled(apkPackage);
            if (isInstalled) {
                this.logger.info("Removing existing app before reinstall", { apkPackage });
                await driver.removeApp(apkPackage);
            }
            return;
        }

        let packages: string[];
        try {
            packages = await listInstalledApps(driver);
        } catch {
            this.logger.warn("Failed to list installed apps for cleanup, continuing with install");
            return;
        }

        const userApps = packages.filter((pkg) => !isBasePackage(pkg));

        for (const pkg of userApps) {
            this.logger.info("Removing existing third-party app", { package: pkg });
            try {
                await driver.removeApp(pkg);
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                if (
                    errorMessage.includes("DELETE_FAILED_DEVICE_POLICY_MANAGER") ||
                    errorMessage.includes("Device Policy Manager")
                ) {
                    this.logger.warn(`Skipping uninstall of DPM-protected app: ${pkg}`, { error: errorMessage });
                    continue;
                }
                throw error;
            }
        }
    }

    private async openInstalledApp(driver: Browser, preferredPackage?: string): Promise<void> {
        const packages = await listInstalledApps(driver);
        if (packages.length === 0) {
            throw new Error("No installed apps found to activate");
        }

        const filteredPackages = packages.filter((pkg) => !isBasePackage(pkg));

        let packageToActivate: string | undefined;

        if (preferredPackage != null && filteredPackages.includes(preferredPackage)) {
            packageToActivate = preferredPackage;
            this.logger.info("Using preferred package", { packageToActivate });
        } else if (filteredPackages.length > 0) {
            packageToActivate = filteredPackages[0];
            if (filteredPackages.length > 1) {
                this.logger.warn(
                    `Multiple user apps found, activating first one: ${packageToActivate}. All apps: ${filteredPackages.join(", ")}`,
                );
            } else {
                this.logger.info("Activating app", { packageToActivate });
            }
        } else {
            this.logger.warn(
                `No user apps found after filtering. Available packages: ${packages.join(", ")}. Using first package: ${packages[0]}`,
            );
            packageToActivate = packages[0];
        }

        if (packageToActivate == null) {
            throw new Error("No suitable app found to activate");
        }

        await driver.activateApp(packageToActivate);
    }
}
