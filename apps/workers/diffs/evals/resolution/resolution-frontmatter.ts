import type { ResolutionAgentResult } from "@autonoma/diffs";
import { z } from "zod";
import {
    type CheckFailure,
    baseFrontmatterSchema,
    checkCountBounds,
    checkIdentifierSet,
    countBoundsSchema,
    identifierSetCheckSchema,
} from "../framework/frontmatter";

/**
 * Deterministic checks for a Resolution case, layered on the shared base.
 *
 * - `modified` / `removed` grade the set of slugs the agent acted on
 *   (include / exclude / exact).
 * - `newTests` bounds how many new tests the agent added.
 * - `reportedBugs` bounds how many bugs the agent reported.
 * - `acceptsCandidate` pins specific candidate ids that MUST have been
 *   accepted - i.e. each id appears as some `newTests[].acceptingCandidateId`.
 *
 * Anything subtler (was the reasoning sound? are the new-test instructions
 * sensible? is the bug report accurate?) belongs in the judge rubric.
 */
export const resolutionFrontmatterSchema = baseFrontmatterSchema.extend({
    modified: identifierSetCheckSchema.optional(),
    removed: identifierSetCheckSchema.optional(),
    newTests: countBoundsSchema.optional(),
    reportedBugs: countBoundsSchema.optional(),
    acceptsCandidate: z.array(z.string()).optional(),
});

export type ResolutionFrontmatter = z.infer<typeof resolutionFrontmatterSchema>;

/** Apply the Resolution deterministic checks to an agent result. Empty list means all checks passed. */
export function checkResolutionResult(
    result: ResolutionAgentResult,
    frontmatter: ResolutionFrontmatter,
): CheckFailure[] {
    const failures: CheckFailure[] = [];

    if (frontmatter.modified != null) {
        const modifiedSlugs = result.modifiedTests.map((t) => t.slug);
        failures.push(...checkIdentifierSet("modified", modifiedSlugs, frontmatter.modified));
    }

    if (frontmatter.removed != null) {
        const removedSlugs = result.removedTests.map((t) => t.slug);
        failures.push(...checkIdentifierSet("removed", removedSlugs, frontmatter.removed));
    }

    if (frontmatter.newTests != null) {
        failures.push(...checkCountBounds("newTests", result.newTests.length, frontmatter.newTests));
    }

    if (frontmatter.reportedBugs != null) {
        failures.push(...checkCountBounds("reportedBugs", result.reportedBugs.length, frontmatter.reportedBugs));
    }

    if (frontmatter.acceptsCandidate != null) {
        const acceptedIds = new Set(
            result.newTests.map((t) => t.acceptingCandidateId).filter((id): id is string => id != null),
        );
        const missing = frontmatter.acceptsCandidate.filter((id) => !acceptedIds.has(id));
        if (missing.length > 0) {
            failures.push({
                check: "acceptsCandidate",
                message: `expected the agent to accept candidates [${missing.join(", ")}] but it did not (accepted: [${[...acceptedIds].join(", ")}])`,
            });
        }
    }

    return failures;
}
