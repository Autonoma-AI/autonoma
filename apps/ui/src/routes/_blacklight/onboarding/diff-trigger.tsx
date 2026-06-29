import { Badge, Button, Skeleton } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGoLive, useOnboardingState } from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { Suspense } from "react";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

export const Route = createFileRoute("/_blacklight/onboarding/diff-trigger")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("diff-trigger")} />,
});

export function DiffTriggerPage({ appId }: { appId?: string }) {
  if (appId == null) {
    return (
      <p className="font-mono text-sm text-text-secondary">No application found. Please start from the beginning.</p>
    );
  }
  return (
    <Suspense fallback={<DiffTriggerSkeleton />}>
      <DiffTriggerContent appId={appId} />
    </Suspense>
  );
}

function DiffTriggerSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 w-full max-w-lg" />
      <Skeleton className="h-32 w-full max-w-2xl" />
      <Skeleton className="h-12 w-40" />
    </div>
  );
}

function DiffTriggerContent({ appId }: { appId: string }) {
  const navigate = useNavigate();
  const { data: state } = useOnboardingState(appId);
  const goLive = useGoLive();

  const isByo = state.previewEnvironmentMode === "existing_deploys";
  const isConfirmed = state.diffTriggerConfirmedAt != null;

  function handleGoLive() {
    goLive.mutate(
      { applicationId: appId },
      { onSuccess: () => void navigate({ to: "/onboarding", search: buildOnboardingSearch("complete", appId) }) },
    );
  }

  return (
    <>
      <OnboardingPageHeader
        leading={
          <div className="mb-4 flex size-12 items-center justify-center border border-primary-ink/30 bg-surface-base">
            <GitPullRequestIcon size={22} weight="duotone" className="text-primary-ink" />
          </div>
        }
        title="Per-PR reviews"
        description={
          <p className="max-w-3xl">
            On every pull request, Autonoma reviews the change on a real preview environment. This is the loop you're
            here for.
          </p>
        }
      />

      <section className="max-w-3xl border border-border-dim bg-surface-base">
        <div className="flex items-center gap-3 border-b border-border-dim bg-surface-raised px-5 py-4">
          <LightningIcon size={18} weight="duotone" className="text-primary-ink" />
          <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">PR reviews are on</h2>
          {isConfirmed && <Badge variant="success">confirmed</Badge>}
        </div>
        <div className="space-y-4 p-6 text-sm text-text-secondary">
          {isByo ? (
            <>
              <p>
                The <span className="font-mono text-primary-ink">deployment_status</span> workflow you added already
                powers per-PR reviews - it's the same single workflow, no extra file and no extra secret. When a PR's
                preview deploys, Autonoma reviews the change against it.
              </p>
              <p className="text-text-secondary">
                We mark you live now and confirm automatically on your first PR deploy. Open a PR to see a review.
              </p>
            </>
          ) : (
            <>
              <p>
                PreviewKit deploys a preview for every pull request and triggers a review automatically - there's
                nothing to wire up.
              </p>
              <p className="text-text-secondary">Open a PR after going live to see your first review.</p>
            </>
          )}
        </div>
      </section>

      <div className="mt-8 flex max-w-3xl justify-end border-t border-border-dim pt-6">
        <Button
          variant="accent"
          className="gap-2 px-6 py-3 font-mono text-sm font-bold uppercase"
          disabled={goLive.isPending}
          onClick={handleGoLive}
          aria-label="onboarding-go-live"
        >
          {goLive.isPending ? "Going live..." : "Go live"}
          <ArrowRightIcon size={16} weight="bold" />
        </Button>
      </div>
    </>
  );
}
