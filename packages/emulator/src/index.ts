export { Emulator } from "./emulator";
export type {
    DeviceInfo,
    EmulatorConfig,
    DeviceDriver,
    Contact,
    EmulatorCreateOptions,
    PrepareDeviceOptions,
    ProxyConfig,
} from "./types";
export { DaemonClient } from "./daemon/client";
export type { DaemonLockInfo } from "./daemon/client";
export { buildLockOwner, parseLockOwner, isValidLockOwner, LockOwnerParamsSchema } from "./lock-owner";
export type { LockOwnerParams } from "./lock-owner";
export { buildIosCapabilities, buildAndroidCapabilities } from "./capabilities";

/**
 * Parse a comma-separated list of daemon hosts into an array.
 * Returns undefined if the input is nullish or empty - callers can pass the
 * result directly to `EmulatorCreateOptions.daemonHosts`.
 */
export function parseDaemonHosts(daemonHosts: string | undefined): string[] | undefined {
    if (daemonHosts == null) return undefined;
    const hosts = daemonHosts
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h.length > 0);
    return hosts.length > 0 ? hosts : undefined;
}
