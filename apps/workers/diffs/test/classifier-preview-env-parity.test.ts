import { PreviewEnvironment } from "@autonoma/diffs/analysis";
import { describe, expect, it } from "vitest";
import { frozenPreviewEnv } from "../evals/classifier/frozen-preview-env";

/**
 * `get_preview_env` only counts as evidence while the replayed answer matches the one production gave. Two
 * ways that can rot, neither of which fails anything else: a filter that stops narrowing the same way, and a
 * bundle read as it stands at capture rather than as it stood at the classification.
 */

const CLASSIFIED_AT = new Date("2026-01-15T00:00:00Z");
const ADDED_SINCE = "LAUNCHDARKLY_SDK_KEY";

/** Stands in for the postgres bundle: the extra key was stored after {@link CLASSIFIED_AT}. */
const SECRETS = {
    getEnvVarNames: async (_target: { applicationId: string }, before?: Date) =>
        before != null
            ? ["STRIPE_SECRET_KEY", "DATABASE_URL", "SENTRY_DSN"]
            : ["STRIPE_SECRET_KEY", "DATABASE_URL", "SENTRY_DSN", ADDED_SINCE],
    getEnvValues: async () => ({}),
};
const CONNECTION_KEYS = ["DATABASE_URL", "NEXT_PUBLIC_API_URL"];
const FILTERS = [undefined, "", "stripe", "URL", "next_public", "NOPE"];

describe("frozen get_preview_env vs the live reader", () => {
    it("answers every filter identically to the preview it was frozen from", async () => {
        const live = new PreviewEnvironment(SECRETS, "app-1", CONNECTION_KEYS, CLASSIFIED_AT);
        const replayed = frozenPreviewEnv(await live.getEnvVarNames());

        for (const filter of FILTERS) {
            expect(await replayed.getEnvVarNames(filter), `filter ${String(filter)}`).toEqual(
                await live.getEnvVarNames(filter),
            );
        }
        // Guard the guard: a comparison over two empty lists would pass while proving nothing.
        expect(await replayed.getEnvVarNames("URL")).toEqual(["DATABASE_URL", "NEXT_PUBLIC_API_URL"]);
    });

    /** A capture runs weeks later; a key stored in between would read as configured on a run that saw it absent. */
    it("freezes the bundle as it stood at the classification, not as it stands at capture", async () => {
        const atCapture = await new PreviewEnvironment(SECRETS, "app-1", CONNECTION_KEYS).getEnvVarNames();
        const frozen = await new PreviewEnvironment(SECRETS, "app-1", CONNECTION_KEYS, CLASSIFIED_AT).getEnvVarNames();

        expect(atCapture).toContain(ADDED_SINCE);
        expect(frozen).not.toContain(ADDED_SINCE);
        expect(await frozenPreviewEnv(frozen).getEnvVarNames("launchdarkly")).toEqual([]);
    });
});
