/** What the caller needs to reconcile an instructions write that lost a race, named from its point of view. */
export interface ApplicationInstructionsConflict {
    /** What is stored right now - the write this one would have overwritten. */
    current: {
        customInstructions: string | null;
        testScopeGuidelines: string | null;
    };
    currentFingerprint: string;
    /** The fingerprint the caller read before editing, which no longer matches. */
    baseFingerprint: string;
}

/**
 * A write whose base is no longer what is stored: someone edited the instructions in between.
 *
 * These fields are prose a human wrote, so an overwrite is unrecoverable - there is no version
 * history to restore from, unlike a scenario recipe. The error therefore carries the current text,
 * because rejecting the write is only half an answer: with its own draft plus what is stored now,
 * an agent has what it needs to merge its addition into the human's wording and retry.
 */
export class ApplicationInstructionsConflictError extends Error {
    constructor(
        readonly applicationId: string,
        readonly conflict: ApplicationInstructionsConflict,
    ) {
        super(
            `The instructions changed since you read them. Expected ${conflict.baseFingerprint.slice(0, 12)}, ` +
                `found ${conflict.currentFingerprint.slice(0, 12)}. Re-read them, merge your change into what is ` +
                `there now, and retry.`,
        );
        this.name = "ApplicationInstructionsConflictError";
    }
}
