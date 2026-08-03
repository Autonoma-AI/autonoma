/**
 * The outcome when a step cannot be completed by an agent, because it requires a person at a
 * browser. Not an error: nothing has gone wrong and retrying will not help.
 *
 * Some steps are irreducibly human. Installing a GitHub App is the clearest - GitHub exposes
 * no API for it, and it requires an org owner's consent on github.com. An agent that treats
 * that as a failure either retries forever or gives up, when the useful thing is to hand its
 * human a link and wait.
 *
 * The shape is uniform so an agent can act on it without knowing anything about the specific
 * step: show `url` to a human, then call `pollWith` until the status changes.
 */
export interface NeedsHumanOutcome {
    status: "needs_human";
    /** Stable machine key for the step, so an agent can branch without parsing prose. */
    action: string;
    /** One sentence a human can act on, suitable to relay verbatim into a chat. */
    reason: string;
    /** The link to hand over. Whoever opens it needs the permissions the step requires. */
    url: string;
    /** Tool to call to find out whether the human has finished. */
    pollWith: string;
    /** When `url` stops working, if it does. ISO 8601. */
    expiresAt?: string;
}

export interface NeedsHumanInput {
    action: string;
    reason: string;
    url: string;
    pollWith: string;
    expiresAt?: Date;
}

/** Build a {@link NeedsHumanOutcome}. */
export function needsHuman({ action, reason, url, pollWith, expiresAt }: NeedsHumanInput): NeedsHumanOutcome {
    return {
        status: "needs_human",
        action,
        reason,
        url,
        pollWith,
        expiresAt: expiresAt?.toISOString(),
    };
}
