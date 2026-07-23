import { logger } from "@autonoma/logger";
import { sleep } from "@autonoma/utils/sleep";
import type { DeviceDriver, PrepareDeviceOptions } from "../types";
import { installContacts } from "./contacts";
import { updateDateOnDevice } from "./date";

/**
 * Package prefixes for system-level and infrastructure apps (Google services, Amazon
 * services, Appium automation, core Android) that should never be uninstalled during
 * device cleanup — removing them can brick the emulator or break automation.
 */
const SYSTEM_APP_PREFIXES = [
    "com.google.android.play",
    "com.google.android",
    "com.google.ar",
    "com.google.vr",
    "com.amazon",
    "io.appium",
    "com.android",
    "android",
];

export class AndroidPrepareDevice {
    async execute(driver: DeviceDriver, options: PrepareDeviceOptions): Promise<void> {
        const { appPath, contacts, proxyConfig } = options;

        await driver.executeScript("mobile: shell", [{ command: "svc wifi disable" }]);

        // Set proxy if the caller's organization requires it
        if (proxyConfig?.proxyOrgIds.includes(proxyConfig.organizationId)) {
            await driver.executeScript("mobile: shell", [
                { command: `settings put global http_proxy ${proxyConfig.proxyHost}:${proxyConfig.proxyPort}` },
            ]);
            await driver.executeScript("mobile: shell", [
                { command: `settings put global global_http_proxy_host ${proxyConfig.proxyHost}` },
            ]);
            await driver.executeScript("mobile: shell", [
                { command: `settings put global global_http_proxy_port ${proxyConfig.proxyPort}` },
            ]);
        }

        const packages = await this.listInstalledApps(driver);
        const packageCount = packages.length;

        if (packageCount > 0) {
            for (let i = 0; i < packages.length; i++) {
                const packageToUninstall = packages[i] as string;
                try {
                    await driver.removeApp(packageToUninstall);
                } catch (error: unknown) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    if (
                        errorMessage.includes("DELETE_FAILED_DEVICE_POLICY_MANAGER") ||
                        errorMessage.includes("Device Policy Manager")
                    ) {
                        logger.warn(`Skipping uninstall of DPM-protected app: ${packageToUninstall}`, {
                            error: errorMessage,
                        });
                        continue;
                    }
                    throw error;
                }
            }
        }

        await sleep(Math.floor(Math.random() * (2000 - 1000)) + 1000);
        logger.info("Enabling wifi...");
        await driver.executeScript("mobile: shell", [{ command: "svc wifi enable" }]);
        await sleep(1000);

        if (appPath != null) {
            logger.info("Installing app...");
            await driver.installApp(appPath);

            logger.info("Launching app...");
            await this.openInstalledApp(driver);
        }

        if (contacts != null && contacts.length > 0) {
            await installContacts(driver, contacts);
        }

        try {
            await updateDateOnDevice(driver);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to update device date: ${message}`);
        }
    }

    private async listInstalledApps(driver: DeviceDriver): Promise<string[]> {
        const output = await driver.executeScript("mobile: shell", [{ command: "pm list packages -3" }]);
        return String(output)
            .split("\n")
            .map((line: string) => line.trim().replace("package:", ""))
            .filter((pkg: string) => pkg !== "" && !pkg.includes("appium"));
    }

    private async waitForAppInstalled(driver: DeviceDriver, packageName: string, maxAttempts = 30): Promise<void> {
        logger.info(`Waiting for app ${packageName} to be installed...`);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const packages = await this.listInstalledApps(driver);
                if (packages.includes(packageName)) {
                    logger.info(`App ${packageName} is now installed (found on attempt ${attempt})`);
                    return;
                }

                if (attempt % 5 === 0) {
                    logger.info(`Still waiting for app to be installed (attempt ${attempt}/${maxAttempts})...`);
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.warn(`Error checking app installation (attempt ${attempt}/${maxAttempts}): ${errorMessage}`);
            }

            await sleep(1_000);
        }

        throw new Error(`App ${packageName} was not installed after ${maxAttempts} attempts`);
    }

    private async openInstalledApp(driver: DeviceDriver): Promise<void> {
        const packages = await this.listInstalledApps(driver);
        if (packages.length === 0) {
            throw new Error("No installed apps found to activate");
        }

        const filteredPackages = packages.filter((pkg) => {
            if (SYSTEM_APP_PREFIXES.some((prefix) => pkg.startsWith(prefix))) return false;
            return true;
        });

        let packageToActivate: string | undefined;

        if (filteredPackages.length > 0) {
            packageToActivate = filteredPackages[0];
            if (filteredPackages.length > 1) {
                logger.warn(
                    `Multiple user apps found, activating first one: ${packageToActivate}. All apps: ${filteredPackages.join(", ")}`,
                );
            } else {
                logger.info(`Activating app: ${packageToActivate}`);
            }
        } else {
            logger.warn(
                `No user apps found after filtering. Available packages: ${packages.join(", ")}. Using first package: ${packages[0]}`,
            );
            packageToActivate = packages[0];
        }

        if (packageToActivate == null) {
            throw new Error("No suitable app found to activate");
        }

        await driver.activateApp(packageToActivate);
    }

    private async findLaunchableUserApp(driver: DeviceDriver): Promise<string> {
        const packages = await this.listInstalledApps(driver);

        const filteredPackages = packages.filter((pkg) => {
            if (SYSTEM_APP_PREFIXES.some((prefix) => pkg.startsWith(prefix))) return false;
            return true;
        });

        logger.info(`Found ${filteredPackages.length} candidate user apps: ${filteredPackages.join(", ")}`);

        if (filteredPackages.length === 0) {
            throw new Error("No user apps found after filtering");
        }

        if (filteredPackages.length === 1) {
            return filteredPackages[0] as string;
        }

        for (const pkg of filteredPackages) {
            try {
                const hasLaunchable = await this.hasLaunchableActivity(driver, pkg);
                if (hasLaunchable) {
                    logger.info(`Found launchable app: ${pkg}`);
                    return pkg;
                }
                logger.debug(`App ${pkg} has no launchable activity, skipping`);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logger.debug(`Error checking launchable activity for ${pkg}: ${message}`);
            }
        }

        logger.warn(`No app with launchable activity found, using first candidate: ${filteredPackages[0]}`);
        return filteredPackages[0] as string;
    }

    private async hasLaunchableActivity(driver: DeviceDriver, packageName: string): Promise<boolean> {
        const output = await driver.executeScript("mobile: shell", [
            { command: `cmd package resolve-activity --brief ${packageName}` },
        ]);

        const result = String(output).trim();
        return result.includes(packageName) && result.includes("/");
    }
}
