import { Button, Panel, PanelBody } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { Link, createFileRoute, redirect, useNavigate, useRouteContext } from "@tanstack/react-router";
import { TalkToSupport } from "components/talk-to-support";
import { navigateToOnboarding } from "lib/onboarding/navigate-to-onboarding";
import { getLastApp } from "./-last-app";

export const Route = createFileRoute("/_blacklight/_app-shell/")({
  beforeLoad: ({ context }) => {
    const lastAppSlug = getLastApp();
    if (lastAppSlug != null) {
      const app = context.applications.find((a) => a.slug === lastAppSlug);
      const isOnboardingComplete = app?.onboardingState == null || app.onboardingState.step === "completed";
      if (app != null && isOnboardingComplete)
        throw redirect({
          to: "/app/$appSlug",
          params: { appSlug: app.slug },
          replace: true,
        });
    }
  },
  component: AppSelector,
});

function AppSelector() {
  const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });
  const navigate = useNavigate();

  const incompleteApps = applications.filter(
    (app) => app.onboardingState != null && app.onboardingState.step !== "completed",
  );
  const completedApps = applications.filter(
    (app) => app.onboardingState == null || app.onboardingState.step === "completed",
  );

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

              {completedApps.map((app) => (
                <Link
                  key={app.id}
                  to="/app/$appSlug"
                  params={{ appSlug: app.slug }}
                  className="group flex items-center justify-between gap-3 px-5 py-3.5 text-sm text-text-primary transition-colors hover:bg-surface-raised"
                >
                  <span className="font-medium">{app.name}</span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-2xs uppercase text-text-tertiary">{app.architecture}</span>
                    <ArrowRightIcon
                      size={14}
                      className="text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="px-5 py-12 text-center text-sm text-text-tertiary">No applications yet.</div>
          )}
        </PanelBody>
      </Panel>

      <div className="mt-6 flex justify-center">
        <Link to="/onboarding/install">
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
