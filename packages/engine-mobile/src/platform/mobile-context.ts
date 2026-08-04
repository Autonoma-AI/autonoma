import type { BaseCommandContext, KeyboardDriver, MouseDriver } from "@autonoma/engine";
import type { MobilePlatform } from "./mobile-application-data";

export interface MobileContext extends BaseCommandContext {
    platform: MobilePlatform;
    mouse: MouseDriver;
    keyboard: KeyboardDriver;
}
