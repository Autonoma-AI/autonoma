import type { DialogObserver, NativeDialogType } from "@autonoma/engine";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { Dialog, Page } from "playwright";

const NATIVE_DIALOG_TYPES: readonly NativeDialogType[] = ["alert", "confirm", "prompt", "beforeunload"];

/** Narrows Playwright's `string` dialog type into our union, warning (and defaulting) on an unknown kind. */
function toNativeDialogType(raw: string, logger: Logger): NativeDialogType {
    const match = NATIVE_DIALOG_TYPES.find((type) => type === raw);
    if (match != null) return match;
    logger.warn("Unrecognized native dialog type, defaulting to alert", { extra: { rawType: raw } });
    return "alert";
}

/**
 * Attaches a native-dialog handler to a Playwright page.
 *
 * Playwright auto-DISMISSES native dialogs when no handler is registered, which silently
 * cancels `confirm()`-gated flows (delete/save) and makes the agent flail clicking an "OK"
 * button that is not in the DOM. We instead auto-ACCEPT so those flows proceed, and record the
 * dialog into the observer so the agent (and the post-run classifier) get ground truth about
 * what the popup said.
 *
 * Covers `alert` / `confirm` / `prompt` (prompts submit their default value). `beforeunload`
 * guards are also accepted - i.e. navigation away from the page is allowed to proceed, matching
 * the same "let the agent's intended action through" policy as the others.
 *
 * The dialog must be resolved here and now: the action that triggered it (e.g. a click) blocks
 * until the dialog is accepted/dismissed, so the decision cannot be deferred to a later agent
 * step. Accept-by-policy is correct for the vast majority of E2E confirmations.
 */
export function attachNativeDialogHandler(page: Page, observer: DialogObserver): void {
    const logger = rootLogger.child({ name: "attachNativeDialogHandler" });

    page.on("dialog", async (dialog: Dialog) => {
        const type = toNativeDialogType(dialog.type(), logger);
        const message = dialog.message();
        // For prompts, submit the page's own default value rather than an empty string.
        const promptValue = type === "prompt" ? dialog.defaultValue() : undefined;

        logger.info("Native dialog appeared, auto-accepting", { extra: { type, message } });

        try {
            await dialog.accept(promptValue);
            observer.record({ type, message, outcome: "accepted", promptValue, occurredAt: Date.now() });
        } catch (error) {
            // A dialog can only be handled once; a benign race (e.g. the page navigating) can make
            // accept throw. Still record the dialog so the agent/classifier knows it fired, marked
            // dismissed since acceptance could not be confirmed.
            logger.warn("Failed to accept native dialog, recording as dismissed", {
                extra: { type, message, error },
            });
            observer.record({ type, message, outcome: "dismissed", promptValue, occurredAt: Date.now() });
        }
    });
}
