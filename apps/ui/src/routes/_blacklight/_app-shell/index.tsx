import { Button, Panel, PanelBody, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Link, createFileRoute, redirect, useNavigate, useRouteContext } from "@tanstack/react-router";
import { TalkToSupport } from "components/talk-to-support";
import { navigateToOnboarding } from "lib/onboarding/navigate-to-onboarding";
import { getLastApp } from "./-last-app";

function isOnboardingComplete(app: { onboardingState?: { step: string } | null }): boolean {
  return app.onboardingState == null || app.onboardingState.step === "completed";
}

export const Route = createFileRoute("/_blacklight/_app-shell/")({
  beforeLoad: ({ context }) => {
    const onboardedApps = context.applications.filter(isOnboardingComplete);

    // Prefer the last viewed app if it is still onboarded, otherwise fall back to the first one.
    const lastAppSlug = getLastApp();
    const targetApp = onboardedApps.find((a) => a.slug === lastAppSlug) ?? onboardedApps[0];

    // Nothing to land on yet (no apps, or none finished onboarding) - show the chooser.
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
  const navigate = useNavigate();

  const incompleteApps = applications.filter((app) => !isOnboardingComplete(app));
  const completedApps = applications.filter(isOnboardingComplete);

  return (
    <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center px-4">
      <header className="mb-8 text-center">
        <h1 className="text-xl font-medium tracking-tight text-text-primary">Select an application</h1>
        <p className="mt-2 font-mono text-xs text-text-secondary">Choose an application to get started.</p>
      </header>

      <Panel>
        <PanelBody className="p-0">
          {applications.length > 0 ? (
            <div className="divide-y divide-border-dim">
              {incompleteApps.length > 0 && (
                <>
                  <div className="px-5 py-2.5">
                    <span className="font-mono text-3xs uppercase tracking-widest text-text-tertiary">
                      Continue setup
                    </span>
                  </div>
                  {incompleteApps.map((app) => (
                    <button
                      key={app.id}
                      type="button"
                      onClick={() => navigateToOnboarding(app.id, app.onboardingState?.step, navigate)}
                      className="group flex w-full items-center justify-between gap-3 px-5 py-3.5 text-sm text-text-tertiary opacity-60 transition-all hover:bg-surface-raised hover:opacity-100"
                    >
                      <span className="font-medium">{app.name}</span>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-3xs uppercase">resume</span>
                        <ArrowRightIcon size={14} className="opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                    </button>
                  ))}
                </>
              )}

              {completedApps.map((app) => {
                const hasNoRepo = app.githubRepositoryId == null;
                return (
                  <Link
                    key={app.id}
                    to={hasNoRepo ? "/app/$appSlug/github" : "/app/$appSlug"}
                    params={{ appSlug: app.slug }}
                    className="group flex items-center justify-between gap-3 px-5 py-3.5 text-sm text-text-primary transition-colors hover:bg-surface-raised"
                  >
                    <span className="flex items-center gap-2 font-medium">
                      {app.name}
                      {hasNoRepo && (
                        <Tooltip>
                          <TooltipTrigger>
                            <WarningCircleIcon size={14} weight="fill" className="text-status-critical" />
                          </TooltipTrigger>
                          <TooltipContent>No repository linked</TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-2xs uppercase text-text-tertiary">{app.architecture}</span>
                      <ArrowRightIcon
                        size={14}
                        className="text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
                      />
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="px-5 py-12 text-center text-sm text-text-tertiary">No applications yet.</div>
          )}
        </PanelBody>
      </Panel>

      <div className="mt-6 flex justify-center">
        <Link to="/onboarding" search={{ step: "cli-setup", appId: undefined, apiKey: undefined, setupId: undefined }}>
          <Button variant="outline" className="gap-2" aria-label="open-create-application-dialog">
            <PlusIcon size={14} />
            New application
          </Button>
        </Link>
      </div>

      <TalkToSupport className="mt-10 w-full max-w-sm" />
    </div>
  );
}
