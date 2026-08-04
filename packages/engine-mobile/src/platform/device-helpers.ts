import type { Logger } from "@autonoma/logger";
import type { Browser } from "webdriverio";
import { env } from "./env";

/**
 * System/vendor app prefixes to filter out when detecting the user's app.
 */
export const SYSTEM_APP_PREFIXES = [
    "com.google",
    "com.android",
    "android",
    "io.appium",
    "com.samsung",
    "com.sec",
    "com.osp",
    "com.amazon",
    "com.airwatch",
    "com.qualcomm",
    "com.mediatek",
    "com.huawei",
    "com.oppo",
    "com.vivo",
    "com.xiaomi",
    "com.oneplus",
    "com.motorola",
    "com.lenovo",
    "com.lge",
    "com.asus",
    "com.sony",
    "com.htc",
    "com.nokia",
    "org.chromium",
];

export function isBasePackage(activity: string): boolean {
    return SYSTEM_APP_PREFIXES.some((prefix) => activity.startsWith(prefix));
}

/**
 * List all installed third-party apps (excluding system and Appium apps).
 */
export async function listInstalledApps(driver: Browser): Promise<string[]> {
    const output = await driver.executeScript("mobile: shell", [{ command: "pm list packages -3" }]);
    return String(output)
        .split("\n")
        .map((line: string) => line.trim().replace("package:", ""))
        .filter((pkg: string) => pkg !== "" && !pkg.includes("appium"));
}

/**
 * Detect the currently active user package on the device.
 */
export async function detectCurrentPackage(driver: Browser, logger?: Logger): Promise<string> {
    logger?.info("Detecting current package");

    const currentPackage = (await driver.getCurrentPackage()) ?? "";
    const isBase = currentPackage === "" || isBasePackage(currentPackage);
    logger?.info("getCurrentPackage result", { currentPackage, isBasePackage: isBase });

    if (!isBase) {
        logger?.info("Current package is not a base package, returning it", { currentPackage });
        return currentPackage;
    }

    logger?.warn("Current package is a base activity, attempting to find the real package");

    let installedApps: string[] = [];

    try {
        const thirdPartyOutput = await driver.executeScript("mobile: shell", [{ command: "pm list packages -3" }]);
        installedApps = String(thirdPartyOutput)
            .split("\n")
            .filter((app) => app.length > 0)
            .map((app) => app.replace("package:", "").trim())
            .filter((app) => app.length > 0 && !isBasePackage(app));

        logger?.info("Third-party packages found", { count: installedApps.length, packages: installedApps });
    } catch (error) {
        logger?.warn("Failed to get third-party apps, falling back to all packages", {
            error: error instanceof Error ? error.message : String(error),
        });
    }

    if (installedApps.length === 0) {
        const allAppsOutput = await driver.executeScript("mobile: shell", [{ command: "pm list packages" }]);
        installedApps = String(allAppsOutput)
            .split("\n")
            .filter((app) => app.length > 0)
            .map((app) => app.replace("package:", "").trim())
            .filter((app) => app.length > 0 && !isBasePackage(app));

        logger?.info("Fallback: all non-base packages", { count: installedApps.length, packages: installedApps });
    }

    const realPackage = installedApps[0];
    if (realPackage == null) {
        throw new Error("No user packages found on device");
    }

    if (installedApps.length > 1) {
        logger?.warn("Multiple user packages found, returning the first one", {
            selected: realPackage,
            allPackages: installedApps,
        });
    } else {
        logger?.info("Found the real package", { package: realPackage });
    }

    return realPackage;
}

/**
 * Set device date/time to GMT+1.
 */
export async function updateDateOnDevice(driver: Browser, _logger?: Logger): Promise<void> {
    if (env.SKIP_DEVICE_DATE_UPDATE) return;

    const GMT_OFFSET_MS = 60 * 60 * 1000;
    const date = new Date(Date.now() + GMT_OFFSET_MS);
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    const dateFmt = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${date.getUTCFullYear()}.00`;

    await driver.executeScript("mobile: shell", [{ command: "settings put global auto_time 0" }]);
    await driver.executeScript("mobile: shell", [{ command: "settings put global auto_time_zone 0" }]);
    await driver.executeScript("mobile: shell", [{ command: `su 0 date ${dateFmt}` }]);
}
