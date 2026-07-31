import matter from "gray-matter";

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

/** Verbs that change something, as opposed to observing it. */
const INTERACTION_VERBS: ReadonlySet<string> = new Set<StepVerb>(["click", "type", "drag"]);

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

/** Whether this verb does something to the app, rather than observing it. */
export function isInteractionVerb(verb: string): boolean {
    return INTERACTION_VERBS.has(verb);
}

/** Whether a step with this verb must say where on screen it looks. */
export function requiresLocation(verb: string): boolean {
    return LOCATED_VERBS.has(verb);
}

/** The interaction verbs, for error messages that have to name them. */
export function describeInteractionVerbs(): string {
    return [...INTERACTION_VERBS].join("/");
}

/** Matches a numbered step line and captures its verb, for any verb (valid or not). */
export const STEP_LINE_PATTERN = /^\d+\.\s+(\w+):/gm;

/** Every generated test must perform at least this many real interactions. */
export const MIN_INTERACTIONS = 2;

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

    const interactions = verbs.filter(isInteractionVerb);
    if (interactions.length < MIN_INTERACTIONS) {
        errors.push(`Only ${interactions.length} interaction(s) (minimum ${MIN_INTERACTIONS})`);
    }

    for (const verb of verbs) {
        if (!isValidVerb(verb)) errors.push(`Invalid verb: "${verb}"`);
    }

    const bodyStart = content.indexOf("---", 3);
    const body = bodyStart > -1 ? content.slice(bodyStart + 3) : content;
    const stepsSection = body.slice(body.indexOf("**Steps**") || 0);
    if (/Dynamic:\s/i.test(stepsSection)) {
        errors.push('Contains "Dynamic:" placeholder in steps');
    }

    return { valid: errors.length === 0, errors };
}
