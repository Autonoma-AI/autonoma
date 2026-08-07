import { Outlet, createFileRoute } from "@tanstack/react-router";
import { RouteErrorState } from "components/route-error-state";
import { SettingsRail } from "./-settings-rail";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/settings")({
  errorComponent: ({ reset }) => <RouteErrorState message="We couldn't load these settings." reset={reset} />,
  component: SettingsLayout,
});

/**
 * Layout for every application-settings destination: the page header and the section rail render once here
 * and the destination fills the Outlet, so switching sections swaps only the body. Each destination used to
 * render its own copy of the header and declare its own active tab; the rail derives the active entry from
 * the matched route instead, so a destination no longer has to know its own name.
 */
function SettingsLayout() {
  const { appSlug } = Route.useParams();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Settings</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">Configure this application</p>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <SettingsRail appSlug={appSlug} />
        {/* One content width for every destination, set here rather than by each of them - they had three
            different answers between them, so General and Scenarios did not line up. `mx-auto` only starts
            doing anything past roughly a 1500px window, where the column would otherwise stretch to fill
            an ultrawide screen; below that it is inert and nothing moves. */}
        <div className="mx-auto min-w-0 w-full max-w-5xl flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
