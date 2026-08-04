import { setTimeout } from "node:timers/promises";
import { Emulator, buildAndroidCapabilities, buildIosCapabilities, parseDaemonHosts } from "@autonoma/emulator";
import { Installer } from "@autonoma/engine";
import { S3Storage } from "@autonoma/storage";
import { type Browser, remote } from "webdriverio";
import z from "zod";
import { AndroidVideoRecorder } from "./android-video-recorder";
import { AppiumImageStream } from "./appium-image-stream";
import { AndroidCameraInjector, type CameraInjector, IosCameraInjector } from "./camera-injector";
import { AppiumApplicationDriver } from "./drivers/appium-application.driver";
import { AndroidKeyboardDriver } from "./drivers/appium-keyboard.driver";
import { AppiumScreenDriver } from "./drivers/appium-screen.driver";
import { AppiumTouchDriver } from "./drivers/appium-touch.driver";
import { IosKeyboardDriver } from "./drivers/ios-keyboard.driver";
import { env } from "./env";
import { IosVideoRecorder } from "./ios-video-recorder";
import type { MobileApplicationData, MobilePlatform } from "./mobile-application-data";
import type { MobileContext } from "./mobile-context";

export interface MobileInstallerConfig {
    daemonHosts?: string[];
    owner?: string;
}

export class InstallationError extends Error {
    constructor(public readonly error: Error) {
        super(`Failed to install app: ${error.message}`);
    }
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

export class MobileInstaller extends Installer<MobileApplicationData, MobileContext> {
    readonly paramsSchema = z.object({
        platform: z.enum(["IOS", "ANDROID"]).default("ANDROID"),
        packageUrl: z.string(),
        packageName: z.string(),
        photo: z.string().optional(),
    });

    /** The Appium driver instance, exposed for cleanup. */
    public driver?: Browser;

    /** The emulator instance, exposed for cleanup (lock release). */
    public emulator?: Emulator;

    constructor(private readonly config: MobileInstallerConfig) {
        super();
    }

    static fromEnv(platform: MobilePlatform, owner?: string): MobileInstaller {
        const daemonHosts =
            platform === "IOS" ? parseDaemonHosts(env.IOS_DAEMON_HOSTS) : parseDaemonHosts(env.ANDROID_DAEMON_HOSTS);

        return new MobileInstaller({ daemonHosts, owner });
    }

    protected async buildContext({ platform, packageUrl, packageName, photo }: MobileApplicationData) {
        this.logger.info("Building mobile context", {
            platform,
            packageUrl,
        });

        const emulator = await Emulator.create({
            config: {
                nodeEnv: env.NODE_ENV,
                architecture: platform,
            },
            owner: this.config.owner,
            daemonHosts: this.config.daemonHosts,
        });
        this.emulator = emulator;

        await emulator.commitLock();
        await emulator.waitForAppium();

        this.logger.info("Generating signed URL for package download", {
            packageUrl,
        });
        const storage = S3Storage.createFromEnv();
        const downloadUrl = await storage.getSignedUrl(packageUrl, 3600);
        this.logger.info("Signed URL generated successfully");

        const driver = await this.connectToAppium(emulator, platform);
        this.driver = driver;

        await emulator.prepareDevice(driver, {
            appPath: downloadUrl,
            appPackage: packageName,
        });

        if (photo != null) {
            this.logger.info("Injecting default camera image", { photo });
            const cameraInjector: CameraInjector =
                platform === "IOS" ? new IosCameraInjector() : new AndroidCameraInjector();
            await cameraInjector.inject(driver, photo);
            this.logger.info("Default camera image injected successfully");
        }

        const hostname = emulator.ip ?? "localhost";
        const mjpegPort = emulator.mjpegPort ?? 4724;
        const imageStream = new AppiumImageStream(hostname, mjpegPort);

        const screenResolution = await driver.getWindowSize();

        const keyboard = platform === "IOS" ? new IosKeyboardDriver(driver) : new AndroidKeyboardDriver(driver);

        const context: MobileContext = {
            platform,
            screen: new AppiumScreenDriver(driver, imageStream),
            mouse: new AppiumTouchDriver(driver, screenResolution),
            keyboard,
            application: new AppiumApplicationDriver(),
        };

        return {
            context,
            imageStream,
            videoRecorder: platform === "IOS" ? new IosVideoRecorder(driver) : new AndroidVideoRecorder(driver),
        };
    }

    private async connectToAppium(emulator: Emulator, platform: MobilePlatform): Promise<Browser> {
        const hostname = emulator.ip ?? "localhost";
        const port = emulator.appiumPort ?? 4723;

        this.logger.info("Connecting to Appium with retry logic", {
            hostname,
            port,
            platform,
            maxRetries: MAX_RETRIES,
            retryDelayMs: RETRY_DELAY_MS,
        });

        const capabilities = platform === "IOS" ? buildIosCapabilities(emulator) : buildAndroidCapabilities(emulator);

        let driver: Browser | undefined;
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            this.logger.info(`Appium connection attempt ${attempt}/${MAX_RETRIES}`);

            try {
                driver = await remote({
                    logLevel: "warn",
                    hostname,
                    port,
                    path: "/",
                    capabilities,
                });
                this.logger.info(`Connected to Appium successfully on attempt ${attempt}`);
                break;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                this.logger.warn(`Appium connection attempt ${attempt} failed`, {
                    error: lastError.message,
                    willRetry: attempt < MAX_RETRIES,
                });

                if (attempt < MAX_RETRIES) {
                    this.logger.info(`Waiting ${RETRY_DELAY_MS}ms before retry`);
                    await setTimeout(RETRY_DELAY_MS);
                }
            }
        }

        if (driver == null) {
            const error = lastError ?? new Error("Unknown error during Appium connection");
            this.logger.error("Failed to connect to Appium after all retries", error);
            throw new InstallationError(error);
        }

        return driver;
    }

    async cleanup(): Promise<void> {
        if (this.driver != null) {
            this.logger.info("Cleaning up Appium session");
            await this.driver.deleteSession();
        }

        if (this.emulator != null) {
            this.logger.info("Cleaning up emulator");
            await this.emulator.release("run-generation-job");
        }
    }
}
