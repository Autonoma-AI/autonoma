import { Skeleton } from "@autonoma/blacklight";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { useCurrentApplication } from "../../-use-current-application";
import { SettingsTabNav } from "../settings/-settings-tab-nav";
import { PreviewDraftProvider } from "./-draft-context";
import { PreviewSaveBar } from "./-save-bar";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/preview-config")({
  component: PreviewConfigLayout,
});

/**
 * Layout for the Preview Environments settings: the settings tab bar, one shared
 * config draft, and the save bar that persists every edit as a single revision.
 * The workspace inside (app rail + selected pane) lives in the index route.
 */
function PreviewConfigLayout() {
  const { appSlug } = Route.useParams();
  const app = useCurrentApplication();

  return (
    <div className="flex flex-col gap-6">
      <SettingsTabNav activeTab="preview" appSlug={appSlug} />
      <Suspense fallback={<PreviewConfigSkeleton />}>
        <PreviewDraftProvider appId={app.id}>
          <Outlet />
          <PreviewSaveBar />
        </PreviewDraftProvider>
      </Suspense>
    </div>
  );
}

function PreviewConfigSkeleton() {
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <Skeleton className="h-64 w-full lg:w-52" />
      <Skeleton className="h-96 min-w-0 flex-1" />
    </div>
  );
}
