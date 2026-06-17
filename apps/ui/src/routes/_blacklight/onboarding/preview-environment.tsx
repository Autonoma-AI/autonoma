import { Button, cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CloudArrowUpIcon } from "@phosphor-icons/react/CloudArrowUp";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSelectPreviewEnvironmentMode } from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import type { ReactNode } from "react";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

export const Route = createFileRoute("/_blacklight/onboarding/preview-environment")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("preview-environment")} />,
});

export function PreviewEnvironmentPage({ appId }: { appId?: string }) {
  const navigate = useNavigate();
  const selectMode = useSelectPreviewEnvironmentMode();

  function choose(mode: "previewkit" | "existing_deploys") {
    if (appId == null) return;
    selectMode.mutate(
      { applicationId: appId, mode },
      {
        onSuccess: () => {
          void navigate({
            to: "/onboarding",
            search: buildOnboardingSearch(mode === "previewkit" ? "previewkit-config" : "existing-deploys", appId),
          });
        },
      },
    );
  }

  if (appId == null) {
    return <p className="font-mono text-sm text-text-secondary">No application found. Please start from setup.</p>;
  }

  return (
    <>
      <OnboardingPageHeader
        leading={
          <div className="mb-4 flex size-12 items-center justify-center border border-primary-ink/30 bg-surface-base">
            <GitBranchIcon size={22} weight="duotone" className="text-primary-ink" />
          </div>
        }
        title="Set up your preview environment"
        description={
          <p className="max-w-3xl">
            Autonoma needs a reachable URL before it can generate and run browser tests. Build the environment with
            PreviewKit or connect deploys you already publish.
          </p>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <ChoiceCard
          active
          icon={<CloudArrowUpIcon size={28} weight="duotone" />}
          title="Build with PreviewKit"
          description="PreviewKit builds your stack for main and future pull requests from a .preview.yaml file in your repo."
          bullets={["Repo-first config", "Apps, services, and databases", "Fastest path for new teams"]}
          actionLabel="Build with PreviewKit"
          onClick={() => choose("previewkit")}
          disabled={selectMode.isPending}
        />
        <ChoiceCard
          icon={<PlugsConnectedIcon size={28} weight="duotone" />}
          title="Use existing deploys"
          description="Keep shipping previews from Vercel or CI and send Autonoma a signed deployment signal when a URL is live."
          bullets={["Signed deployment signal", "Manual/provider snippets", "No PreviewKit infrastructure"]}
          actionLabel="Connect my deploys"
          onClick={() => choose("existing_deploys")}
          disabled={selectMode.isPending}
        />
      </div>

      <div className="mt-8 border-l-2 border-primary-ink bg-primary-ink/10 px-5 py-4">
        <p className="font-mono text-2xs uppercase tracking-widest text-primary-ink">Why this step</p>
        <p className="mt-2 text-sm text-text-secondary">
          No live preview means no trustworthy generation. This step produces the URL Autonoma will test.
        </p>
      </div>
    </>
  );
}

function ChoiceCard({
  active,
  icon,
  title,
  description,
  bullets,
  actionLabel,
  onClick,
  disabled,
}: {
  active?: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  bullets: string[];
  actionLabel: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <section
      className={cn(
        "flex min-h-80 flex-col justify-between border bg-surface-base p-8",
        active ? "border-primary-ink shadow-[0_0_24px_var(--accent-glow)]" : "border-border-dim",
      )}
    >
      <div>
        <div
          className={cn(
            "mb-7 flex size-12 items-center justify-center border",
            active ? "border-primary-ink text-primary-ink" : "border-border-mid text-text-secondary",
          )}
        >
          {icon}
        </div>
        <h2 className="text-2xl font-medium text-text-primary">{title}</h2>
        <p className="mt-4 text-sm leading-relaxed text-text-secondary">{description}</p>
        <div className="mt-7 space-y-3">
          {bullets.map((bullet) => (
            <p key={bullet} className="font-mono text-2xs text-text-secondary">
              <span className="mr-2 text-primary-ink">·</span>
              {bullet}
            </p>
          ))}
        </div>
      </div>
      <Button
        variant={active ? "accent" : "outline"}
        className="mt-8 w-fit gap-2 px-6 py-3"
        onClick={onClick}
        disabled={disabled}
      >
        {actionLabel}
        <ArrowRightIcon size={16} weight="bold" />
      </Button>
    </section>
  );
}
