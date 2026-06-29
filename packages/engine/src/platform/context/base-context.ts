import type { DialogObserver } from "../dialog-observer";
import type { ApplicationDriver, ScreenDriver } from "../drivers";

/** The base context for all platforms. */
export interface BaseCommandContext {
    /** The screen driver. */
    screen: ScreenDriver;

    /** The application driver. */
    application: ApplicationDriver;

    /**
     * Observes native browser dialogs (alert / confirm / prompt) the platform auto-handles.
     * Only wired up on platforms that have native dialogs (web), and only when the feature is
     * enabled - absent otherwise, so the agent simply skips dialog reporting.
     */
    dialogs?: DialogObserver;
}
