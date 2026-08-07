import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysPanel } from "components/api-keys/api-keys-panel";
import { RouteErrorState } from "components/route-error-state";
import { OrgScopeNote } from "../-org-scope-note";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/settings/api-keys/")({
  errorComponent: ({ reset }) => <RouteErrorState message="We couldn't load your API keys." reset={reset} />,
  component: ApiKeysPage,
});

/**
 * `trpc.apiKeys.list` takes no application id - one key authenticates the CLI and API against everything in
 * the organization. This used to exist twice, once here and once on a standalone organization page, both
 * reading and writing the same keys.
 */
function ApiKeysPage() {
  return (
    <div className="flex flex-col gap-4">
      <OrgScopeNote>API keys authenticate the Autonoma CLI and API.</OrgScopeNote>
      <ApiKeysPanel />
    </div>
  );
}
