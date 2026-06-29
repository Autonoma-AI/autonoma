import { type Logger, logger } from "@autonoma/logger";

/** The native browser dialog types a page can raise. Mirrors Playwright's `Dialog.type()`. */
export type NativeDialogType = "alert" | "confirm" | "prompt" | "beforeunload";

/** A single native dialog that appeared during a run and how it was resolved. */
export interface NativeDialogEvent {
    /** The dialog kind. */
    type: NativeDialogType;

    /** The dialog text shown to the user (e.g. "Are you sure you want to delete?"). */
    message: string;

    /** How the handler resolved the dialog. */
    outcome: "accepted" | "dismissed";

    /** For `prompt` dialogs, the text the handler submitted (the dialog's default value). */
    promptValue?: string;

    /** Epoch millis when the dialog was handled. */
    occurredAt: number;
}

/**
 * Collects native browser dialogs (alert / confirm / prompt) as they are auto-handled
 * by the platform driver, so the agent can be told they happened.
 *
 * Native dialogs are browser chrome, not DOM, so they never appear in a screenshot. The
 * platform handler resolves them by policy the moment they fire (it cannot defer to a later
 * agent step - the action that triggered the dialog blocks until it is resolved) and records
 * the outcome here. The agent drains the buffer once per step via {@link takePending} and
 * surfaces it as context, giving the classifier ground truth about what the popup said.
 */
/**
 * Soft cap on the unread buffer, so a page firing dialogs in a loop (e.g. recursive
 * `beforeunload`/`confirm`) cannot grow memory unbounded between agent steps. The agent
 * drains once per step, so this only bites if dialogs fire faster than the agent advances.
 */
const MAX_PENDING_DIALOGS = 50;

export class DialogObserver {
    private readonly logger: Logger;
    private events: NativeDialogEvent[] = [];

    constructor() {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /** Record a dialog that was just handled by the platform driver. */
    record(event: NativeDialogEvent): void {
        this.logger.info("Recording native dialog", {
            extra: { type: event.type, outcome: event.outcome },
        });
        this.events.push(event);

        if (this.events.length > MAX_PENDING_DIALOGS) {
            this.events.shift();
            this.logger.warn("Native dialog buffer exceeded cap, dropped oldest event", {
                extra: { cap: MAX_PENDING_DIALOGS },
            });
        }
    }

    /** Return the dialogs recorded since the last call and clear the buffer. */
    takePending(): NativeDialogEvent[] {
        if (this.events.length === 0) return [];
        const pending = this.events;
        this.events = [];
        this.logger.info("Surfacing pending native dialogs to agent", { extra: { count: pending.length } });
        return pending;
    }
}
