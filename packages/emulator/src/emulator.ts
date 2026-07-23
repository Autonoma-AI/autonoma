import { logger } from "@autonoma/logger";
import { sleep } from "@autonoma/utils/sleep";
import { DaemonClient } from "./daemon/client";
import { AndroidPrepareDevice } from "./prepare/android-prepare-device";
import { IosPrepareDevice } from "./prepare/ios-prepare-device";
import type { DeviceDriver, DeviceInfo, EmulatorConfig, EmulatorCreateOptions, PrepareDeviceOptions } from "./types";

/** Fisher-Yates shuffle — returns a new array, does not mutate the input. */
function shuffled<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j] as T, result[i] as T];
    }
    return result;
}

export class Emulator {
    ip?: string;
    name?: string;
    appiumPort?: number;
    mjpegPort?: number;
    systemPort?: number;
    adbPort?: number;
    proxyPort?: number;
    private deviceId?: string;
    private deviceInfo?: DeviceInfo;

    private constructor(
        public readonly config: EmulatorConfig,
        public readonly owner?: string,
        private daemonClient?: DaemonClient,
    ) {}

    /**
     * Static factory — absorbs createEmulatorIfNeeded() logic. Throws on failure.
     *
     * Two paths:
     * 1. Development: dummy device info, no locking
     * 2. HTTP daemon: acquire lock via daemon, setup device
     */
    static async create(options: EmulatorCreateOptions): Promise<Emulator> {
        const { config, owner, daemonHosts } = options;

        // Development mode — no locking needed
        if (config.nodeEnv !== "production") {
            const emulator = new Emulator(config, owner);
            await emulator.setup();
            return emulator;
        }

        // HTTP daemon path — the standard production path
        if (daemonHosts == null || daemonHosts.length === 0) {
            throw new Error(
                "daemonHosts is empty - at least one daemon host is required for production device locking",
            );
        }

        return Emulator.acquireFromDaemons(daemonHosts, config, owner);
    }

    /**
     * Try each daemon host in a loop until one successfully returns a lock.
     * Hosts are shuffled once for load distribution, then retried in that fixed order.
     * Waits 1s + jitter between full passes to avoid thundering herd.
     */
    private static async acquireFromDaemons(
        hosts: string[],
        config: EmulatorConfig,
        owner?: string,
    ): Promise<Emulator> {
        const ordered = shuffled(hosts);

        while (true) {
            for (const host of ordered) {
                try {
                    const client = new DaemonClient(host);
                    const emulator = new Emulator(config, owner, client);
                    await emulator.setup();
                    logger.info(
                        `Locked emulator from daemon ${client.getHostname()} with device ${client.getDeviceID()}`,
                    );
                    return emulator;
                } catch {
                    // pass
                }
            }

            const jitter = Math.floor(Math.random() * 2000);
            await sleep(1000 + jitter);
        }
    }

    /**
     * Device preparation — delegates to IosPrepareDevice / AndroidPrepareDevice. Throws on failure.
     */
    async prepareDevice(driver: DeviceDriver, options: PrepareDeviceOptions): Promise<void> {
        if (this.config.architecture === "IOS") {
            const prepare = new IosPrepareDevice(this);
            await prepare.execute(driver, options);
        } else if (this.config.architecture === "ANDROID") {
            const prepare = new AndroidPrepareDevice();
            await prepare.execute(driver, options);
        } else {
            throw new Error(`Unsupported architecture for prepareDevice: ${this.config.architecture}`);
        }
    }

    /**
     * Commit the soft lock to a hard lock
     * HTTP daemon starts the emulator on lock acquisition — no soft->hard upgrade needed
     */
    async commitLock(): Promise<void> {
        if (this.config.nodeEnv === "development") {
            logger.info("Development mode: skipping lock commit");
            return;
        }

        logger.info(`HTTP daemon: skipping commitLock (device=${this.deviceId})`);
    }

    async release(caller: string) {
        if (this.config.nodeEnv === "development") {
            logger.info("Development mode: skipping lock release");
            return;
        }

        if (this.daemonClient == null) {
            logger.warn("release called but no daemonClient available", { caller });
            return;
        }

        logger.info(`Releasing device via HTTP daemon: ${this.deviceId}`, { caller });
        await this.daemonClient.releaseLock();
        this.deviceId = undefined;
        this.deviceInfo = undefined;
    }

    async waitForAppium(): Promise<void> {
        logger.info(`Waiting for device ${this.deviceId} to be ready...`);
        logger.info(`Checking Appium at http://${this.ip}:${this.appiumPort}/status`);

        let attempts = 0;
        const maxAttempts = 240; // 2 minutes with 500ms intervals

        while (attempts < maxAttempts) {
            try {
                const res = await fetch(`http://${this.ip}:${this.appiumPort}/status`, {
                    signal: AbortSignal.timeout(5000), // 5 second timeout per request
                });
                if (res.status === 200) {
                    logger.info(`Device ${this.deviceId} is ready after ${attempts} attempts`);
                    break;
                }
                logger.warn(`Appium returned status ${res.status}, retrying...`);
            } catch (error: unknown) {
                if (attempts % 20 === 0) {
                    // Log and report progress every 10 seconds
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    logger.warn(`Still waiting for Appium (attempt ${attempts}/${maxAttempts}): ${errorMessage}`);
                }
            } finally {
                await sleep(500);
                attempts++;
            }
        }

        if (attempts >= maxAttempts) {
            logger.error(`Appium did not become ready after ${maxAttempts} attempts (${maxAttempts * 500}ms)`);
            process.exit(1);
        }

        logger.info(`Device ${this.deviceId} Appium is ready`);
    }

    async fetchSimulatorLogs(): Promise<string | undefined> {
        if (this.daemonClient == null) return undefined;
        return this.daemonClient.fetchSimulatorLogs();
    }

    getDeviceId(): string | undefined {
        return this.deviceId;
    }

    getDeviceInfo(): DeviceInfo | undefined {
        return this.deviceInfo;
    }

    private async setup() {
        await this.lock();
        this.ip = await this.getRemoteIP();
        this.name = this.getDeviceName();
        this.appiumPort = this.deviceInfo?.appiumPort;
        this.mjpegPort = this.deviceInfo?.mjpegStreamPort;
        this.systemPort = this.deviceInfo?.wdaPort;
        this.adbPort = this.getAdbPort();
        this.proxyPort = this.getProxyPort();
        // Note: Don't wait for Appium here! The lock must be committed first so the
        // emulator-daemon can start Appium. AppiumEngine will handle waiting for Appium.

        logger.debug("Emulator setup complete with properties: ", {
            ip: this.ip,
            name: this.name,
            appiumPort: this.appiumPort,
            mjpegPort: this.mjpegPort,
            deviceId: this.deviceId,
            systemPort: this.systemPort,
            proxyPort: this.proxyPort,
        });
    }

    private async getRemoteIP(): Promise<string> {
        if (this.config.nodeEnv !== "production") return "localhost";
        if (this.deviceInfo?.hostname == null) throw new Error("this.deviceInfo.hostname is null");

        const hostname = this.deviceInfo.hostname;
        logger.info("Using device hostname for remote IP", {
            hostname,
            deviceId: this.deviceInfo.deviceId,
            machineId: this.deviceInfo.machineId,
            architecture: this.deviceInfo.architecture,
        });

        return hostname;
    }

    private getDeviceName(): string {
        if (this.config.architecture === "ANDROID") return "emulator-5554";
        if (this.config.architecture !== "IOS") throw new Error(`Unsupported architecture ${this.config.architecture}`);

        if (this.deviceId == null) throw new Error("Device ID is not set");

        // Extract index from deviceId pattern: "machineId-device-X"
        const match = this.deviceId.match(/-device-(\d+)$/);
        const index = match ? match[1] : "0";
        return `iPhone 16${this.config.nodeEnv === "development" ? "" : `-${index}`}`;
    }

    private getAdbPort(): number {
        if (this.config.architecture === "ANDROID") {
            return 5037;
        }
        if (this.config.architecture !== "IOS") throw new Error(`Unsupported architecture ${this.config.architecture}`);

        return 0;
    }

    private getProxyPort(): number {
        if (this.config.architecture !== "IOS") return 0;
        if (!this.deviceInfo) return 0;
        const index = this.deviceInfo?.appiumPort - 4723;
        return 9300 + index;
    }

    private async lock() {
        if (this.config.architecture == null) {
            throw new Error("ARCHITECTURE env not set");
        }

        if (this.config.nodeEnv !== "production") {
            // In development, use dummy device info
            this.deviceId = "dev-device-0";
            this.deviceInfo = {
                deviceId: "dev-device-0",
                machineId: "dev-machine",
                health: { status: "healthy" },
                hostname: "localhost",
                appiumPort: 4723,
                mjpegStreamPort: 9200,
                wdaPort: 8100,
                lastSeen: Date.now(),
                deviceType: "runner",
                architecture: this.config.architecture,
            };
            return;
        }

        // HTTP daemon path — the only production path
        if (this.daemonClient == null) {
            throw new Error("Emulator not initialized with daemonClient in production mode");
        }

        const lockInfo = await this.daemonClient.acquireLock(this.owner ?? "unknown");
        const hostname = this.daemonClient.getHostname();

        this.deviceId = `daemon-device-${lockInfo.id}`;
        this.deviceInfo = {
            deviceId: this.deviceId,
            machineId: hostname,
            health: { status: "healthy" },
            hostname,
            appiumPort: lockInfo.appiumPort,
            mjpegStreamPort: lockInfo.mjpegPort,
            wdaPort: lockInfo.systemPort,
            lastSeen: Date.now(),
            deviceType: "runner",
            architecture: this.config.architecture,
        };

        logger.info(`Acquired device via HTTP daemon: ${this.deviceId}`);
    }
}
