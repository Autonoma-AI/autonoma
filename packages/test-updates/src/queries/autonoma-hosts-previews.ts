import type { OnboardingPreviewEnvironmentMode } from "@autonoma/db";

/**
 * Whether Autonoma builds and hosts this application's previews. Only an explicit `previewkit` choice does - an app
 * that picked `existing_deploys`, and one that has not picked yet, both mean the customer deploys their own preview
 * and only their trigger knows the URL.
 *
 * Every caller must ask through here: the webhook entry that decides whether to open a run and the run's own
 * `resolvePreviewTarget` have to agree on what an absent choice means, and a disagreement starts runs against a
 * preview that will never be recorded.
 */
export function autonomaHostsPreviews(mode: OnboardingPreviewEnvironmentMode | null | undefined): boolean {
    return mode === "previewkit";
}
