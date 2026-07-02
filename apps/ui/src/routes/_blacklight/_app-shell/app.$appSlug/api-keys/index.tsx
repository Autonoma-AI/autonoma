import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysPanel } from "components/api-keys/api-keys-panel";
import { SettingsTabNav } from "../settings/-settings-tab-nav";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/api-keys/")({
  component: ApiKeysPage,
});

function ApiKeysPage() {
  const { appSlug } = Route.useParams();

  return (
    <div className="flex flex-col gap-6">
      <SettingsTabNav activeTab="api-keys" appSlug={appSlug} />
      <ApiKeysPanel />
    </div>
  );
}
