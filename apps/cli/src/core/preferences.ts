import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { debugLog } from "./debug";
import { AUTONOMA_HOME } from "./output";

/**
 * Choices that belong to the person rather than to a project, kept beside the
 * per-project output directories rather than inside one. Which coding agent someone
 * uses is a fact about their machine: asking again in the next repository is asking
 * a question they have already answered.
 */
const PREFERENCES_FILE = join(AUTONOMA_HOME, "preferences.json");

/**
 * Parsed rather than trusted. This file is on the user's disk, hand-editable, and
 * written by whatever version of the CLI they last ran - so a field that has since
 * changed shape must read as "no preference" rather than reach a caller.
 */
const PreferencesSchema = z.object({
    /** The coding agent id (`claude`, `codex`) last chosen from the picker. */
    agentId: z.string().optional(),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

/**
 * The stored preferences, or an empty set.
 *
 * Never throws. A missing file is the normal first run, and a corrupt one is not
 * worth ending a run over - the cost of ignoring it is one question asked again.
 */
export async function readPreferences(): Promise<Preferences> {
    try {
        const raw = await readFile(PREFERENCES_FILE, "utf-8");
        const parsed = PreferencesSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
            debugLog("Ignoring unreadable preferences file", { issues: parsed.error.issues });
            return {};
        }
        return parsed.data;
    } catch (err) {
        debugLog("No preferences to read", { err });
        return {};
    }
}

/**
 * Merge `update` into what is stored. Merged rather than replaced so a caller can
 * record one choice without having to know every other field.
 *
 * Never throws: a read-only home directory must not end a run over a convenience.
 */
export async function updatePreferences(update: Preferences): Promise<void> {
    try {
        const current = await readPreferences();
        const next: Preferences = { ...current, ...update };
        await mkdir(AUTONOMA_HOME, { recursive: true });
        await writeFile(PREFERENCES_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
        debugLog("Saved preferences", { update });
    } catch (err) {
        debugLog("Could not save preferences", { err });
    }
}
