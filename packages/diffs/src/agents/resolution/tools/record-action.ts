import { FixableToolError } from "@autonoma/ai";
import type { ResolutionActionKind, ResolutionAgentLoop } from "../resolution-agent-loop";

class DuplicateActionError extends FixableToolError {
    constructor(
        public readonly slug: string,
        public readonly priorKind: ResolutionActionKind,
    ) {
        super(
            `slug ${slug} already has an action this iteration (${priorKind}). Each failure gets exactly one action - pick the most appropriate and drop the others.`,
        );
    }
}

/**
 * Atomically claim a failed slug for a per-failure action, enforcing the
 * "one action per slug per run" invariant. Throws a fixable error if the
 * slug already has an action so the model can choose which one to keep.
 *
 * Callers (modify_test, remove_test, report_bug) invoke this after their
 * own slug validations and before pushing into their typed action array.
 */
export function recordResolutionAction(loop: ResolutionAgentLoop, slug: string, kind: ResolutionActionKind): void {
    const prior = loop.handledSlugs.get(slug);
    if (prior != null) throw new DuplicateActionError(slug, prior);
    loop.handledSlugs.set(slug, kind);
}
