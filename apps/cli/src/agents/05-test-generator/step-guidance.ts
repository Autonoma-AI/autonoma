/**
 * The guidance shown to the model for a step's `description` and `location`
 * fields, and the guard that rejects a value which quotes that guidance back
 * instead of following it.
 *
 * A weak model filling the structured `write_test` call sometimes echoes a
 * field's own describe text into the field VALUE: a real run copied the location
 * field's rationale ("...acting on the wrong one fails confusingly. Not needed
 * for scroll or refresh...") into the description of every step of five journey
 * files. The value was non-empty and had no placeholder token, so the schema and
 * the on-disk sweep both passed it through.
 *
 * The guard is derived from these strings, so it never drifts: whatever the
 * model is told, it may not repeat back into a value. That means the guidance
 * must keep the distinctive rationale a leak would quote - it is what makes a
 * regurgitated value recognizable - with only short examples, which stay well
 * under the run-length threshold and so can double as real values safely.
 */

export const STEP_DESCRIPTION_GUIDANCE =
    "What to do or check, naming the exact visible text. The verb is prepended automatically, so do not start this with the verb. For assert, the thing expected on screen, e.g. 'text \"Transfer Successful\"'.";

export const STEP_LOCATION_GUIDANCE =
    'Where on screen the target is, e.g. "in the modal" or "as a page heading". Required for click, type and assert: the same label often appears more than once and acting on the wrong one fails confusingly. Not needed for scroll or refresh, which act on the page.';

const STEP_GUIDANCE: readonly string[] = [STEP_DESCRIPTION_GUIDANCE, STEP_LOCATION_GUIDANCE];

/**
 * A value that repeats this many consecutive words of the guidance is quoting
 * the instructions, not describing the screen.
 */
const MIN_ECHOED_WORDS = 6;

// Split on any non-alphanumeric run so punctuation becomes a word boundary, not
// part of a word. A quote survives a stray comma or casing difference, and the
// guidance's own examples ("as a page heading") tokenize to short runs that stay
// well under the threshold.
function words(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 0);
}

/** Every run of exactly `size` consecutive words in `text`, joined by single spaces. */
function wordRuns(text: string, size: number): string[] {
    const tokens = words(text);
    const runs: string[] = [];
    for (let start = 0; start + size <= tokens.length; start++) {
        runs.push(tokens.slice(start, start + size).join(" "));
    }
    return runs;
}

// Precomputed once: the set of word-runs that appear in the guidance the model
// is shown. Built per guidance string so a run can never span two of them.
const GUIDANCE_RUNS: ReadonlySet<string> = new Set(STEP_GUIDANCE.flatMap((g) => wordRuns(g, MIN_ECHOED_WORDS)));

/**
 * Whether `text` quotes the step-field guidance back - the signature of a model
 * that copied a field's instructions into its value. Both step fields are
 * checked against all step guidance, because the real leak put the location
 * field's guidance into the description field.
 */
export function echoesStepGuidance(text: string | undefined): boolean {
    if (text == null) return false;
    return wordRuns(text, MIN_ECHOED_WORDS).some((run) => GUIDANCE_RUNS.has(run));
}
