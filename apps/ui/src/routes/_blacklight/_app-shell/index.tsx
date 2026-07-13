import { Button, Card, Progress, buttonVariants, cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { QuestionIcon } from "@phosphor-icons/react/Question";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Link, createFileRoute, redirect, useRouteContext } from "@tanstack/react-router";
import { SUPPORT_URL } from "components/talk-to-support";
import { env } from "env";
import { useAuth } from "lib/auth";
import { buildResumeSearch } from "lib/onboarding/navigate-to-onboarding";
import { getOnboardingProgress } from "lib/onboarding/onboarding-progress";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { type ReactNode, useState } from "react";
import { getLastApp } from "./-last-app";

const APP_TYPE_LABELS: Record<string, string> = {
  WEB: "Web application",
  IOS: "iOS application",
  ANDROID: "Android application",
};

interface AppCardData {
  id: string;
  name: string;
  slug: string;
  architecture: string;
  githubRepositoryId?: number | null;
  onboardingState?: { step: string } | null;
}

function isOnboardingComplete(app: { onboardingState?: { step: string } | null }): boolean {
  return app.onboardingState == null || app.onboardingState.step === "completed";
}

function appTypeLabel(architecture: string): string {
  return APP_TYPE_LABELS[architecture] ?? "Application";
}

export const Route = createFileRoute("/_blacklight/_app-shell/")({
  beforeLoad: ({ context }) => {
    const onboardedApps = context.applications.filter(isOnboardingComplete);
    const incompleteApps = context.applications.filter((app) => !isOnboardingComplete(app));

    // Only land on the hub when the user has nothing usable yet but does have a setup
    // in flight - so they can resume it. As soon as a single app is fully configured we
    // deep-link straight into it instead of showing this picker.
    const shouldShowHub = onboardedApps.length === 0 && incompleteApps.length > 0;
    if (shouldShowHub) return;

    // No configured apps and nothing in progress: handled one level up (the app-shell
    // route redirects to onboarding when there are no applications at all).
    if (onboardedApps.length === 0) return;

    // At least one app is ready - deep-link into it. Prefer the last viewed, otherwise the first.
    const lastAppSlug = getLastApp();
    const targetApp = onboardedApps.find((a) => a.slug === lastAppSlug) ?? onboardedApps[0];
    if (targetApp == null) return;

    throw redirect({
      to: "/app/$appSlug",
      params: { appSlug: targetApp.slug },
      replace: true,
    });
  },
  component: AppSelector,
});

function AppSelector() {
  const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
  const { user } = useAuth();
  const incompleteApps = applications.filter((app) => !isOnboardingComplete(app));
  const completedApps = applications.filter(isOnboardingComplete);
  const hasCompleted = completedApps.length > 0;
  const isInternal = user?.email?.endsWith(`@${env.VITE_INTERNAL_DOMAIN}`) ?? false;

  return (
    // min-h-full + my-auto centers the content when it fits, but top-aligns and stays
    // scrollable when the list overflows (plain justify-center clips the first card).
    <div className="flex min-h-full w-full flex-col">
      <div className="mx-auto my-auto w-full max-w-2xl px-4 pt-10 pb-24">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-medium tracking-tight text-text-primary">Your applications</h1>
            <p className="mt-1.5 text-sm text-text-secondary">
              {hasCompleted
                ? "Open an existing application or continue a setup in progress."
                : "Choose an application to continue setup."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isInternal && (
              <Link to="/admin">
                <Button variant="outline" className="gap-2">
                  <ShieldCheckIcon size={14} />
                  Admin
                </Button>
              </Link>
            )}
            <Link to="/onboarding" search={buildOnboardingSearch("add-app")}>
              <Button variant="outline" className="gap-2">
                <PlusIcon size={14} />
                Set up another application
              </Button>
            </Link>
          </div>
        </header>

        <div className="flex flex-col gap-6">
          {hasCompleted && (
            <CollapsibleSection title="Ready to use" count={completedApps.length}>
              {completedApps.map((app) => (
                <CompletedAppCard key={app.id} app={app} />
              ))}
            </CollapsibleSection>
          )}

          {incompleteApps.length > 0 && (
            <CollapsibleSection title="Setup in progress" count={incompleteApps.length}>
              {incompleteApps.map((app) => (
                <InProgressAppCard key={app.id} app={app} />
              ))}
            </CollapsibleSection>
          )}
        </div>

        <div className="mt-10 flex items-center justify-center gap-1.5 text-xs text-text-secondary">
          <QuestionIcon size={14} />
          <span>Need help?</span>
          <a
            href={SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-text-primary hover:underline"
          >
            Talk to support
          </a>
        </div>
      </div>
    </div>
  );
}

function CollapsibleSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
          {title}
          <span className="grid min-w-5 place-items-center rounded-full bg-surface-raised px-1.5 py-0.5 text-2xs font-medium text-text-secondary tabular-nums">
            {count}
          </span>
        </span>
        <CaretDownIcon size={16} className={cn("text-text-secondary transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="flex flex-col gap-3">{children}</div>}
    </section>
  );
}

function AppGlyph({ name }: { name: string }) {
  return (
    <div className="grid size-10 shrink-0 place-items-center border border-border-mid bg-surface-raised font-mono text-sm font-medium text-text-primary">
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function CompletedAppCard({ app }: { app: AppCardData }) {
  const hasNoRepo = app.githubRepositoryId == null;

  return (
    <Link
      to={hasNoRepo ? "/app/$appSlug/github" : "/app/$appSlug"}
      params={{ appSlug: app.slug }}
      aria-label={`Open ${app.name}`}
      className="group block"
    >
      <Card className="gap-4 p-4 transition-colors group-hover:border-primary group-focus-visible:border-primary">
        <div className="flex items-center gap-3">
          <AppGlyph name={app.name} />
          <div className="flex flex-col gap-0.5">
            <span className="text-base font-semibold text-text-primary">{app.name}</span>
            <span className="text-xs text-text-secondary">{appTypeLabel(app.architecture)}</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-xs text-text-secondary">
            {hasNoRepo ? (
              <>
                <WarningCircleIcon size={14} weight="fill" className="text-status-critical" />
                No repository linked
              </>
            ) : (
              <>
                <CheckCircleIcon size={14} weight="fill" className="text-status-success" />
                Setup complete
              </>
            )}
          </span>
          <span className={cn(buttonVariants({ variant: "secondary" }), "gap-2")}>
            Open application
            <ArrowRightIcon size={14} className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </Card>
    </Link>
  );
}

function InProgressAppCard({ app }: { app: AppCardData }) {
  const progress = getOnboardingProgress(app.onboardingState?.step);

  return (
    <Link
      to="/onboarding"
      search={buildResumeSearch(app.onboardingState?.step, app.id)}
      aria-label={`Continue setting up ${app.name}`}
      className="group block"
    >
      <Card className="gap-4 p-4 transition-colors group-hover:border-primary group-focus-visible:border-primary">
        <div className="flex items-center gap-3">
          <AppGlyph name={app.name} />
          <div className="flex flex-col gap-0.5">
            <span className="text-base font-semibold text-text-primary">{app.name}</span>
            <span className="text-xs text-text-secondary">{appTypeLabel(app.architecture)}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-text-secondary tabular-nums">
            {progress.completed} of {progress.total} steps complete
          </span>
          <Progress value={progress.percent} />
        </div>

        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-text-secondary">
            Next: <span className="font-medium text-text-primary">{progress.nextStep}</span>
          </p>
          <span className={cn(buttonVariants({ variant: "default" }), "gap-2")}>
            Continue setup
            <ArrowRightIcon size={14} className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </Card>
    </Link>
  );
}
