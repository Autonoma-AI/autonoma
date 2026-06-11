/**
 * The normalized, command-agnostic shape of one reviewed step, shared by both
 * reviewers so a single command-aware renderer can serve them. It deliberately
 * carries only the high-signal command fields and is keyed on the existing
 * `interaction` string - there is no Zod schema, no stored discriminant, and the
 * concrete per-command output shapes are *not* hoisted into this package (the
 * renderer narrows them locally instead). That typed-column cleanup is a
 * separate, deliberately-deferred follow-up.
 *
 * - On **success**, `output` carries the command's structured result (e.g. an
 *   `assert`'s per-assertion `results`, a resolved click `point`, a `wait`'s
 *   `conditionMet`/`reasoning`). This is the false-positive-`success` signal a
 *   reviewer reads to decide whether a step that "succeeded" actually did.
 * - On **failure**, `error` (the message) and `errorName` (the error class) are
 *   present instead. `errorName` is a *classifier, not a verdict*: e.g.
 *   `ElementNotFoundError` can mean a stale step or a genuinely missing element.
 */
export interface ReviewStep {
    interaction: string;
    params: unknown;
    status: "success" | "failed";
    /** The command's structured result. Present on success. */
    output?: unknown;
    /** The thrown error's message. Present on failure. */
    error?: string;
    /** The thrown error's class name (an attribution classifier). Present on failure. */
    errorName?: string;
}
