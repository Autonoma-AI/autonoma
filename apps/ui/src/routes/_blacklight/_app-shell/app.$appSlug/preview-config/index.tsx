import { Skeleton } from "@autonoma/blacklight";
import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { useCurrentApplication } from "../../-use-current-application";
import { SettingsTabNav } from "../settings/-settings-tab-nav";
import { PreviewConfigEditor } from "./-preview-config-editor";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/preview-config/")({
  component: PreviewConfigPage,
});

function PreviewConfigPage() {
  const { appSlug } = Route.useParams();
  const app = useCurrentApplication();

  return (
    <div className="flex flex-col gap-6">
      <SettingsTabNav activeTab="preview" appSlug={appSlug} />
      <Suspense fallback={<PreviewConfigEditorSkeleton />}>
        <PreviewConfigEditor appId={app.id} />
      </Suspense>
    </div>
  );
}

function PreviewConfigEditorSkeleton() {
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
