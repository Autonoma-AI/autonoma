import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSelectPreviewEnvironmentMode } from "lib/onboarding/onboarding-api";
import {
  type OnboardingOrigin,
  type OnboardingSignalProvider,
  buildOnboardingSearch,
} from "lib/onboarding/onboarding-search";
import { PreviewRouterQuiz } from "./-components/preview-router-quiz";

export const Route = createFileRoute("/_blacklight/onboarding/preview-environment")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("preview-environment")} />,
});

/**
 * The routing quiz is the whole preview-environment step. It opens on a
 * per-branch-previews gate ("do you have previews?" - No routes to PreviewKit,
 * Yes continues into the provider + isolation questions) and commits the chosen
 * mode via `selectPreviewEnvironmentMode`, exactly as the old two cards did.
 * Vercel-origin users skip the intro (gate + provider picker) and start on the
 * backend question with Vercel preselected. Back from the first screen returns
 * to the repo step.
 */
export function PreviewEnvironmentPage({ appId, origin }: { appId?: string; origin?: OnboardingOrigin }) {
  const navigate = useNavigate();
  const selectMode = useSelectPreviewEnvironmentMode();

  function choose(mode: "previewkit" | "existing_deploys", provider?: OnboardingSignalProvider) {
    if (appId == null) return;
    selectMode.mutate(
      { applicationId: appId, mode },
      {
        onSuccess: () => {
          void navigate({
            to: "/onboarding",
            search: buildOnboardingSearch(mode === "previewkit" ? "previewkit-config" : "existing-deploys", appId, {
              provider,
            }),
          });
        },
      },
    );
  }

  function backToRepo() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("add-app", appId, { origin }) });
  }

  if (appId == null) {
    return <p className="font-mono text-sm text-text-secondary">No application found. Please start from setup.</p>;
  }

  return (
    <PreviewRouterQuiz
      appId={appId}
      startProvider={origin === "vercel" ? "vercel" : undefined}
      onChoose={choose}
      onBack={backToRepo}
    />
  );
}
