import { Button } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSetUrl } from "lib/onboarding/onboarding-api";
import { useState } from "react";
import { getOnboardingApplicationId } from "./install";

export const Route = createFileRoute("/_blacklight/onboarding/url")({
  component: UrlPage,
});

function UrlPage() {
  const applicationId = getOnboardingApplicationId();
  const [appUrl, setAppUrl] = useState("");

  const navigate = useNavigate();
  const setUrl = useSetUrl();

  const isLoading = setUrl.isPending;

  function handleSubmit() {
    if (appUrl.length === 0 || applicationId == null) return;

    setUrl.mutate(
      { productionUrl: appUrl },
      {
        onSuccess: () => {
          void navigate({ to: "/onboarding/complete" });
        },
      },
    );
  }

  return (
    <div className="py-16">
      <header className="mb-10 border-b border-border-dim pb-8">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-primary-ink/20 bg-surface-base">
          <GlobeIcon size={22} weight="duotone" className="text-primary-ink" />
        </div>
        <h1 className="text-4xl font-medium tracking-tight text-text-primary">Where is your app running?</h1>
        <p className="mt-3 font-mono text-sm text-text-secondary">
          Provide the URL of the environment you want Autonoma to test against.
        </p>
      </header>

      <div className="space-y-8">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="app-url" className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
            Application URL
          </label>
          <input
            id="app-url"
            type="url"
            value={appUrl}
            onChange={(e) => setAppUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="https://staging.your-app.com"
            className="w-full max-w-lg border border-border-dim bg-surface-base px-4 py-2.5 font-mono text-sm text-text-primary placeholder-text-tertiary/50 outline-none focus:border-primary-ink/50"
          />
          <p className="font-mono text-2xs text-text-tertiary">This can be your staging, preview, or production URL.</p>
        </div>

        <Button
          variant="accent"
          className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
          onClick={handleSubmit}
          disabled={appUrl.length === 0 || isLoading || applicationId == null}
          aria-label="onboarding-url-submit"
        >
          {isLoading ? "starting..." : "Start Generating Tests"}
          <ArrowRightIcon size={18} weight="bold" />
        </Button>
      </div>
    </div>
  );
}
