import type {
    ApplicationDriver,
    BaseCommandContext,
    ClipboardDriver,
    KeyboardDriver,
    NavigationDriver,
    WebMouseDriver,
} from "@autonoma/engine";

export interface WebContext extends BaseCommandContext {
    mouse: WebMouseDriver;
    keyboard: KeyboardDriver;
    clipboard: ClipboardDriver;
    application: ApplicationDriver;
    navigation: NavigationDriver;
}
