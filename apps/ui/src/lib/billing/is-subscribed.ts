/**
 * Subscription states that count as paying. `trialing` is included because a trial has an active
 * plan - the sidebar must not badger someone who already subscribed into subscribing again.
 */
const SUBSCRIBED_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

/** Whether the organization has a live subscription. Undefined status means no billing row at all. */
export function isSubscribed(subscriptionStatus: string | undefined): boolean {
    return subscriptionStatus != null && SUBSCRIBED_STATUSES.has(subscriptionStatus);
}
