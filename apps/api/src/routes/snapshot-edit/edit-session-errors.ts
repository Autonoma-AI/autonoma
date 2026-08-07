import { ConflictError } from "@autonoma/errors";

/**
 * The three ways the editor loses the branch's single pending-snapshot slot. All map to a 409, and all carry copy
 * the UI can show verbatim: the caller's next move is to reload, not to retry the same call.
 */

/** The session's snapshot is no longer open - an analysis run superseded it, or it was already finalized. */
export class EditSessionSupersededError extends ConflictError {
    constructor() {
        super("This edit session is no longer active. Reload the page to see the current state of the branch.");
        this.name = "EditSessionSupersededError";
    }
}

/** The branch's pending snapshot belongs to the analysis pipeline, which the editor must never read or write. */
export class AnalysisInFlightError extends ConflictError {
    constructor() {
        super("A new commit is being analyzed on this branch. The test suite cannot be edited until it finishes.");
        this.name = "AnalysisInFlightError";
    }
}

/** Another edit session already holds the slot - one branch, one session. */
export class EditSessionAlreadyOpenError extends ConflictError {
    constructor() {
        super("An edit session is already open on this branch. Reload the page to continue it.");
        this.name = "EditSessionAlreadyOpenError";
    }
}
