import { Button, Card, Progress, buttonVariants, cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { QuestionIcon } from "@phosphor-icons/react/Question";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Link, createFileRoute, redirect, useRouteContext } from "@tanstack/react-router";
import { SUPPORT_URL } from "components/talk-to-support";
import { buildResumeSearch } from "lib/onboarding/navigate-to-onboarding";
import { getOnboardingProgress } from "lib/onboarding/onboarding-progress";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
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
    const incompleteApps = context.applications.filter((app) => !isOnboardingComplete(app));

    // Something is still mid-setup: show the hub so the user can resume it (and open any finished apps).
    if (incompleteApps.length > 0) return;

    // Everything is set up - deep-link straight into an app rather than showing a one-item hub.
    // Prefer the last viewed app, otherwise the first one.
    const onboardedApps = context.applications.filter(isOnboardingComplete);
    const lastAppSlug = getLastApp();
    const targetApp = onboardedApps.find((a) => a.slug === lastAppSlug) ?? onboardedApps[0];

    // No apps at all is handled one level up (the app-shell route redirects to onboarding).
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
  const incompleteApps = applications.filter((app) => !isOnboardingComplete(app));
  const completedApps = applications.filter(isOnboardingComplete);
  const hasCompleted = completedApps.length > 0;

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col justify-center px-4 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-medium tracking-tight text-text-primary">Your applications</h1>
          <p className="mt-1.5 text-sm text-text-secondary">
            {hasCompleted
              ? "Open an existing application or continue a setup in progress."
              : "Choose an application to continue setup."}
          </p>
        </div>
        <Link to="/onboarding" search={buildOnboardingSearch("add-app")}>
          <Button variant="outline" className="gap-2">
            <PlusIcon size={14} />
            Set up another application
          </Button>
        </Link>
      </header>

      <div className="flex flex-col gap-8">
        {hasCompleted && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-text-primary">Ready to use</h2>
            {completedApps.map((app) => (
              <CompletedAppCard key={app.id} app={app} />
            ))}
          </section>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-text-primary">Setup in progress</h2>
          {incompleteApps.map((app) => (
            <InProgressAppCard key={app.id} app={app} />
          ))}
        </section>
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
