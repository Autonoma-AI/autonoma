import { useState } from "react";
import { type CommandShell, defaultShellForUserAgent } from "./planner-command";

/**
 * Which shell the copied command is written for, and a way to change it.
 *
 * Seeded from the browser rather than left on a default, because the person who needs
 * the selector is exactly the person who would otherwise be handed a command that
 * cannot run - and expecting them to spot a dropdown before their first paste is the
 * failure this fixes, not a fix for it.
 *
 * Deliberately not persisted. A shell is a property of the machine someone is sitting
 * at, so re-reading the user agent on the next visit is more accurate than replaying a
 * click made on a different one.
 */
export function useCommandShell() {
    return useState<CommandShell>(() => defaultShellForUserAgent(navigator.userAgent));
}
