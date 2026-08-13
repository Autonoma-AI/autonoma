import matter from "@11ty/gray-matter";

/**
 * The step verbs a generated test may use.
 *
 * `read` is deliberately absent. The engine does implement a read command that
 * captures screen text into a `{{variable}}`, but tests may not reference
 * `{{...}}` tokens, so a captured value could never be used - and reaching for
 * it produced assertions relative to a remembered earlier state, which the
 * visual agent cannot evaluate.
 */
export const STEP_VERBS = ["click", "type", "scroll", "assert", "hover", "drag", "refresh"] as const;

export type StepVerb = (typeof STEP_VERBS)[number];

/** Membership view over `STEP_VERBS`, for checking a verb parsed out of markdown. */
export const VALID_VERBS: ReadonlySet<string> = new Set(STEP_VERBS);

/**
 * Verbs whose step must say WHERE on screen its target is.
 *
 * Every verb that addresses a specific element, not just the ones that check
 * one. `click: the "Add Funds" button` looks unambiguous until the same label
 * exists in the header and inside the modal the first click opened - a real
 * generated test did exactly that, and 47% of that model's action steps named no
 * location at all. A click on the wrong element fails later and more confusingly
 * than an assertion on the wrong element.
 *
 * `scroll` and `refresh` act on the page rather than an element, so neither
 * needs one.
 */
const LOCATED_VERBS: ReadonlySet<string> = new Set<StepVerb>(["assert", "click", "type"]);

export function isValidVerb(verb: string): boolean {
    return VALID_VERBS.has(verb);
}

/** Whether a step with this verb must say where on screen it looks. */
export function requiresLocation(verb: string): boolean {
    return LOCATED_VERBS.has(verb);
}

/** Matches a numbered step line and captures its verb, for any verb (valid or not). */
export const STEP_LINE_PATTERN = /^\d+\.\s+(\w+):/gm;

/**
 * A step line whose verb marker is doubled - `1. assert: assert: ...`. The verb
 * is meant to be rendered exactly once as the marker; a second verb-colon means
 * the model repeated it inside the description and the render strip missed the
 * shape. Derived from STEP_VERBS so it tracks the verb set, and requires both
 * halves to be real verbs so an ordinary target that merely starts with a word
 * plus colon is not mistaken for one. It is the backstop for the deterministic
 * strip in renderSteps, because a doubled marker is malformed against the
 * `N. verb: target` layout the downstream platform parses.
 */
const DOUBLED_VERB_MARKER_PATTERN = new RegExp(
    `^\\d+\\.\\s+(?:${STEP_VERBS.join("|")}):\\s+(?:${STEP_VERBS.join("|")}):`,
    "im",
);

/** The verbs in a test's step list, in order. Invalid verbs are included so callers can reject them. */
export function parseStepVerbs(content: string): string[] {
    return [...content.matchAll(STEP_LINE_PATTERN)].map((m) => m[1]!);
}

/**
 * The criticality levels a generated test may declare, most severe first. The
 * write_test schema validates against this and the suite index tallies by it, so
 * both derive from here - a level added or renamed in one place and not the other
 * silently drops out of the index, or lingers there as a forever-zero row.
 */
export const CRITICALITY_LEVELS = ["critical", "high", "mid", "low"] as const;

interface ValidationResult {
    valid: boolean;
    errors: string[];
}

export function validateTestContent(content: string): ValidationResult {
    const errors: string[] = [];

    if (!/^---\n[\s\S]*?\n---/.test(content)) {
        errors.push("Missing frontmatter");
    } else {
        try {
            const { data } = matter(content);
            if (!data.verification || typeof data.verification !== "string" || data.verification.length < 20) {
                errors.push(
                    "Missing or insufficient 'verification' field in frontmatter - must describe WHERE to navigate and WHAT to assert at the source of truth",
                );
            }
        } catch {
            errors.push("Failed to parse frontmatter");
        }
    }

    if (!/\*\*Intent\*\*:/.test(content)) {
        errors.push("Missing **Intent**: section");
    }

    const verbs = parseStepVerbs(content);

    for (const verb of verbs) {
        if (!isValidVerb(verb)) errors.push(`Invalid verb: "${verb}"`);
    }

    if (DOUBLED_VERB_MARKER_PATTERN.test(content)) {
        errors.push(
            'Doubled verb marker in a step line (e.g. "assert: assert:") - the verb is rendered once as the marker; the description must not repeat it',
        );
    }

    const bodyStart = content.indexOf("---", 3);
    const body = bodyStart > -1 ? content.slice(bodyStart + 3) : content;
    // indexOf returns -1 when the marker is absent; -1 is truthy, so `|| 0` would
    // slice off the last character instead of scanning the whole body.
    const stepsAt = body.indexOf("**Steps**");
    const stepsSection = body.slice(stepsAt > -1 ? stepsAt : 0);
    if (/Dynamic:\s/i.test(stepsSection)) {
        errors.push('Contains "Dynamic:" placeholder in steps');
    }

    return { valid: errors.length === 0, errors };
}
