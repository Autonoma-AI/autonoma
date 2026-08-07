import posthog from "lib/posthog";
import { useEffect, useState } from "react";

/**
 * Single source of truth for PostHog experiment (A/B test) flag keys. The key
 * must match the "Feature flag key" of the experiment configured in PostHog.
 */
export const EXPERIMENTS = {
    exampleOnboardingCopy: "example-onboarding-copy",
} as const;

export type ExperimentKey = (typeof EXPERIMENTS)[keyof typeof EXPERIMENTS];

/**
 * Returns the variant a user is bucketed into for a PostHog experiment, or
 * `undefined` until flags have loaded (dev, first paint, or PostHog disabled).
 * Treat `undefined` as the control path so the UI renders sensibly regardless.
 *
 * Reading the flag here is what registers the experiment exposure in PostHog -
 * `getAllFlags` and similar do not count, so always go through this hook.
 */
export function useExperiment(key: ExperimentKey): string | boolean | undefined {
    const [variant, setVariant] = useState(() => posthog.getFeatureFlag(key));

    useEffect(() => {
        // Re-read synchronously so a key change doesn't leave the previous
        // key's variant on screen for one render. onFeatureFlags then fires
        // once flags resolve and again on any refresh; the returned function
        // unsubscribes on unmount / key change.
        setVariant(posthog.getFeatureFlag(key));
        return posthog.onFeatureFlags(() => {
            setVariant(posthog.getFeatureFlag(key));
        });
    }, [key]);

    return variant;
}
