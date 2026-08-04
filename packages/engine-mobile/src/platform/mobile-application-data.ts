import type { ApplicationArchitecture } from "@autonoma/db";

export type MobilePlatform = Exclude<ApplicationArchitecture, "WEB">;

export interface MobileApplicationData {
    /** Mobile platform architecture for this run. */
    platform: MobilePlatform;
    packageUrl: string;
    /** The app bundle ID (iOS) or package name (Android). */
    packageName: string;
    /** The photo to inject into the device camera. */
    photo?: string;
}
