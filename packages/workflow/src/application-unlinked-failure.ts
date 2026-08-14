import { APPLICATION_UNLINKED_FAILURE_TYPE } from "@autonoma/types";

/**
 * Whether a failure - or any failure on its `.cause` chain - is the one an analysis activity throws when it finds
 * its application was unlinked or deleted mid-run (its `githubRepositoryId` went null under it).
 *
 * Matched by the Temporal `ApplicationFailure.type` the activity stamps ({@link APPLICATION_UNLINKED_FAILURE_TYPE},
 * a namespaced constant), read STRUCTURALLY off the error's `type` field rather than with `instanceof`: the one
 * detector serves both the workflow sandbox and the worker interceptor, and the two cannot share a single
 * `ApplicationFailure` class import (one bundles `@temporalio/workflow`, the other must not). The activity observes
 * the raw failure; the workflow observes it below the generic `ActivityFailure` wrapper on the `.cause` chain (the
 * same chain `rootFailureMessage` walks).
 */
export function isApplicationUnlinkedFailure(error: unknown): boolean {
    let current: unknown = error;
    while (current instanceof Error) {
        if (failureType(current) === APPLICATION_UNLINKED_FAILURE_TYPE) return true;
        current = current.cause;
    }
    return false;
}

/** The Temporal `ApplicationFailure.type` off an error, or undefined for an error that carries none. */
function failureType(error: Error): string | undefined {
    const type: unknown = Reflect.get(error, "type");
    return typeof type === "string" ? type : undefined;
}
