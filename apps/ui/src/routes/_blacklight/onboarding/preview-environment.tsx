import { Badge, Button, Skeleton, cn } from "@autonoma/blacklight";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { CloudIcon } from "@phosphor-icons/react/Cloud";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import type { Icon } from "@phosphor-icons/react/lib";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { PlugsIcon } from "@phosphor-icons/react/Plugs";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useOnboardingState, useSelectPreviewEnvironmentMode } from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { Suspense, useState } from "react";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

export const Route = createFileRoute("/_blacklight/onboarding/preview-environment")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("preview-environment")} />,
});

type PreviewEnvironmentMode = "previewkit" | "existing_deploys";

const DEFAULT_MODE: PreviewEnvironmentMode = "previewkit";

interface PreviewMethodBenefit {
  text: string;
  icon: Icon;
}

interface PreviewMethodOption {
  mode: PreviewEnvironmentMode;
  badge: string;
  badgeVariant: "default" | "secondary";
  title: string;
  description: string;
  benefits: PreviewMethodBenefit[];
  footer: string;
}

const PREVIEW_METHOD_OPTIONS: PreviewMethodOption[] = [
  {
    mode: "previewkit",
    badge: "Recommended",
    badgeVariant: "default",
    title: "Let Autonoma manage preview environments",
    description: "Autonoma deploys your stack and creates a unique preview URL for every pull request.",
    benefits: [
      { text: "Apps, databases and services supported", icon: CubeIcon },
      { text: "No preview infrastructure to maintain", icon: CloudIcon },
      { text: "Setup time: about 5-10 minutes", icon: ClockIcon },
    ],
    footer: "Best if you do not already have reliable per-PR previews.",
  },
  {
    mode: "existing_deploys",
    badge: "Existing setup",
    badgeVariant: "secondary",
    title: "Use your existing preview environments",
    description: "Keep your current deployment process and show Autonoma how to find each preview URL.",
    benefits: [
      { text: "Keep your current hosting or deployment platform", icon: PlugsIcon },
      { text: "Connect a provider or preview URL pattern", icon: LinkIcon },
      { text: "Setup time: about 2 minutes", icon: ClockIcon },
    ],
    footer: "Best if every pull request already receives a stable URL.",
  },
];

const SELECTION_SUMMARY: Record<PreviewEnvironmentMode, { title: string; description: string; cta: string }> = {
  previewkit: {
    title: "Selected: Autonoma-managed preview environments",
    description:
      "Next, we'll analyze your repository and suggest a configuration. Nothing will be deployed without your approval.",
    cta: "Continue with Autonoma-managed previews",
  },
  existing_deploys: {
    title: "Selected: Existing preview environments",
    description: "Next, we'll ask how Autonoma can find the preview URL for each pull request.",
    cta: "Continue with existing previews",
  },
};

function restoreMode(persisted: PreviewEnvironmentMode | null): PreviewEnvironmentMode {
  return persisted === "existing_deploys" ? "existing_deploys" : DEFAULT_MODE;
}

export function PreviewEnvironmentPage({ appId }: { appId?: string }) {
  if (appId == null) {
    return <p className="font-mono text-sm text-text-secondary">No application found. Please start from setup.</p>;
  }

  return (
    <Suspense fallback={<PreviewEnvironmentSkeleton />}>
      <PreviewEnvironmentContent appId={appId} />
    </Suspense>
  );
}

function PreviewEnvironmentSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 w-full max-w-2xl" />
      <Skeleton className="h-5 w-full max-w-xl" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function PreviewEnvironmentContent({ appId }: { appId: string }) {
  const navigate = useNavigate();
  const selectMode = useSelectPreviewEnvironmentMode();
  const { data: onboardingState } = useOnboardingState(appId);
  const [selectedMode, setSelectedMode] = useState<PreviewEnvironmentMode>(
    restoreMode(onboardingState.previewEnvironmentMode),
  );

  function handleContinue() {
    selectMode.mutate(
      { applicationId: appId, mode: selectedMode },
      {
        onSuccess: () => {
          void navigate({
            to: "/onboarding",
            search: buildOnboardingSearch(
              selectedMode === "previewkit" ? "previewkit-config" : "existing-deploys",
              appId,
            ),
          });
        },
      },
    );
  }

  const summary = SELECTION_SUMMARY[selectedMode];

  return (
    <>
      <OnboardingPageHeader
        title="How would you like to set up preview environments?"
        description={
          <p className="max-w-3xl">
            Choose whether Autonoma creates them or connects to your existing setup. You can change this later.
          </p>
        }
      />

      <RadioGroup
        value={selectedMode}
        onValueChange={(value: PreviewEnvironmentMode) => setSelectedMode(value)}
        disabled={selectMode.isPending}
        aria-label="How would you like to set up preview environments?"
        className="grid gap-5 lg:grid-cols-2"
      >
        {PREVIEW_METHOD_OPTIONS.map((option) => (
          <PreviewMethodCard key={option.mode} option={option} />
        ))}
      </RadioGroup>

      <div className="mt-6 border border-border-dim border-l-4 border-l-primary-ink bg-surface-base px-5 py-4">
        <p className="font-medium text-text-primary">{summary.title}</p>
        <p className="mt-1.5 text-sm text-text-secondary">{summary.description}</p>
      </div>

      <div className="mt-6 flex justify-end border-t border-border-dim pt-6">
        <Button
          variant="accent"
          className="gap-2 px-6 py-3"
          onClick={handleContinue}
          disabled={selectMode.isPending}
          data-testid={`onboarding-continue-${selectedMode}`}
        >
          {summary.cta}
          <ArrowRightIcon size={16} weight="bold" />
        </Button>
      </div>
    </>
  );
}

function PreviewMethodCard({ option }: { option: PreviewMethodOption }) {
  return (
    <Radio.Root
      value={option.mode}
      render={<div />}
      aria-label={`${option.title}, ${option.badge}`}
      data-testid={`onboarding-select-${option.mode}`}
      className={cn(
        "group/option flex cursor-pointer flex-col rounded-none border p-6 text-left outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-primary-ink/50",
        "data-[unchecked]:border-border-mid data-[unchecked]:bg-surface-base data-[unchecked]:hover:border-border-highlight",
        "data-[checked]:border-primary-ink data-[checked]:bg-primary-ink/5 data-[checked]:shadow-[0_0_24px_var(--accent-glow)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <Badge variant={option.badgeVariant} className="font-mono text-3xs uppercase tracking-wider">
          {option.badge}
        </Badge>
        <span
          aria-hidden="true"
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
            "group-data-[unchecked]/option:border-border-mid",
            "group-data-[checked]/option:border-primary-ink group-data-[checked]/option:bg-primary-ink",
          )}
        >
          <span className="size-2 rounded-full bg-surface-void opacity-0 transition-opacity group-data-[checked]/option:opacity-100" />
        </span>
      </div>

      <h2 className="mt-5 text-xl font-medium text-text-primary lg:text-2xl">{option.title}</h2>
      {/* min-h reserves 2 lines so both cards align below even if only one wraps. */}
      <p className="mt-3 min-h-10 text-xs leading-relaxed text-text-secondary">{option.description}</p>

      <div className="mt-5 space-y-3 border-t border-border-dim pt-5">
        {option.benefits.map((benefit) => (
          <div key={benefit.text} className="flex items-start gap-2.5">
            <benefit.icon size={14} weight="bold" className="mt-0.5 shrink-0 text-primary-ink" />
            <span className="text-xs text-text-secondary">{benefit.text}</span>
          </div>
        ))}
      </div>

      <p className="mt-5 text-xs text-text-secondary">{option.footer}</p>
    </Radio.Root>
  );
}
