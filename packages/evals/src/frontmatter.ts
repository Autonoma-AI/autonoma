import { z } from "zod";

/**
 * Shared deterministic-check primitives for per-step eval frontmatter.
 *
 * Each per-step `expected.md` frontmatter schema is composed from these. The
 * primitives are intentionally output-shaped (sets of identifiers, count
 * bounds, numeric bands) so they grade the structured agent output without an
 * LLM. Anything the deterministic checks cannot express is left to the judge
 * rubric in the body.
 */

/** Fields every per-step frontmatter schema carries. */
export const baseFrontmatterSchema = z.object({
    /** Human note describing what the case exercises. Ignored by checks. */
    description: z.string().optional(),
    /** When true, the case is loaded but its body is not run (e.g. freshly captured, not yet authored). */
    skip: z.boolean().optional(),
});

/**
 * A set-membership check over identifiers (e.g. test slugs). `include` and
 * `exclude` are partial constraints; `exact` pins the whole set. They may be
 * combined (e.g. `exclude` alongside `exact` is redundant but not an error).
 */
export const identifierSetCheckSchema = z.object({
    /** Every identifier here MUST appear in the actual set. */
    include: z.array(z.string()).optional(),
    /** None of these identifiers may appear in the actual set. */
    exclude: z.array(z.string()).optional(),
    /** The actual set must equal exactly this set (order-insensitive). */
    exact: z.array(z.string()).optional(),
});

export type IdentifierSetCheck = z.infer<typeof identifierSetCheckSchema>;

/** Inclusive count bounds over some output collection. */
export const countBoundsSchema = z.object({
    minCount: z.number().int().nonnegative().optional(),
    maxCount: z.number().int().nonnegative().optional(),
});

export type CountBounds = z.infer<typeof countBoundsSchema>;

/** Inclusive numeric band (both ends optional), e.g. for a confidence score. */
export const confidenceBandSchema = z.object({
    min: z.number().optional(),
    max: z.number().optional(),
});

export type ConfidenceBand = z.infer<typeof confidenceBandSchema>;

/** A single failed deterministic check. An empty failure list means the checks passed. */
export interface CheckFailure {
    /** Which check produced the failure (e.g. `"affected.include"`). */
    check: string;
    /** Human-readable explanation of the mismatch. */
    message: string;
}

/** Check an identifier set against include / exclude / exact constraints. */
export function checkIdentifierSet(label: string, actual: string[], spec: IdentifierSetCheck): CheckFailure[] {
    const failures: CheckFailure[] = [];
    const actualSet = new Set(actual);

    if (spec.include != null) {
        const missing = spec.include.filter((id) => !actualSet.has(id));
        if (missing.length > 0) {
            failures.push({
                check: `${label}.include`,
                message: `expected to include [${missing.join(", ")}] but they were absent (actual: [${actual.join(", ")}])`,
            });
        }
    }

    if (spec.exclude != null) {
        const present = spec.exclude.filter((id) => actualSet.has(id));
        if (present.length > 0) {
            failures.push({
                check: `${label}.exclude`,
                message: `expected to exclude [${present.join(", ")}] but they were present`,
            });
        }
    }

    if (spec.exact != null) {
        const expectedSet = new Set(spec.exact);
        const missing = spec.exact.filter((id) => !actualSet.has(id));
        const extra = actual.filter((id) => !expectedSet.has(id));
        if (missing.length > 0 || extra.length > 0) {
            failures.push({
                check: `${label}.exact`,
                message: `set mismatch (missing: [${missing.join(", ")}], unexpected: [${extra.join(", ")}])`,
            });
        }
    }

    return failures;
}

/** Check a collection's size against inclusive min / max bounds. */
export function checkCountBounds(label: string, actualCount: number, spec: CountBounds): CheckFailure[] {
    const failures: CheckFailure[] = [];

    if (spec.minCount != null && actualCount < spec.minCount) {
        failures.push({
            check: `${label}.minCount`,
            message: `expected at least ${spec.minCount} but got ${actualCount}`,
        });
    }

    if (spec.maxCount != null && actualCount > spec.maxCount) {
        failures.push({
            check: `${label}.maxCount`,
            message: `expected at most ${spec.maxCount} but got ${actualCount}`,
        });
    }

    return failures;
}

/** Check a numeric value falls inside an inclusive band. A missing actual value fails. */
export function checkConfidenceBand(label: string, actual: number | undefined, band: ConfidenceBand): CheckFailure[] {
    if (actual == null) {
        return [{ check: label, message: "expected a confidence value but none was produced" }];
    }

    const failures: CheckFailure[] = [];
    if (band.min != null && actual < band.min) {
        failures.push({ check: `${label}.min`, message: `expected >= ${band.min} but got ${actual}` });
    }
    if (band.max != null && actual > band.max) {
        failures.push({ check: `${label}.max`, message: `expected <= ${band.max} but got ${actual}` });
    }
    return failures;
}

/** Check a value equals an expected enum literal. */
export function checkEnumEquality<T>(label: string, actual: T, expected: T): CheckFailure[] {
    if (actual === expected) return [];
    return [{ check: label, message: `expected ${String(expected)} but got ${String(actual)}` }];
}
