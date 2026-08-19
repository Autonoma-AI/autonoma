import { Tabs, TabsList, TabsTrigger } from "@autonoma/blacklight";
import { useAuth } from "lib/auth";
import { usePreviewEnvironmentSummary } from "lib/query/deployments.queries";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export type PRTab = "overview" | "preview" | "usage";

// The tab switcher, rendered as a bare Tabs widget (the meta row that hosts it owns the
// border/background/padding). Rendered only for PRs backed by a real previewkit_environment: a
// non-preview PR (BYO deploy, or none) renders no tabs at all.
export function PRTabs({
  applicationId,
  prNumber,
  active,
}: {
  applicationId: string;
  prNumber: number;
  active: PRTab;
}) {
  const { data: summary } = usePreviewEnvironmentSummary(applicationId, prNumber);
  const { isAdmin } = useAuth();
  if (summary.source !== "previewkit") return null;

  return (
    <Tabs value={active}>
      <TabsList variant="line">
        <TabsTrigger
          value="overview"
          render={<AppLink to="/app/$appSlug/pull-requests/$prNumber" params={{ prNumber }} />}
        >
          Analysis
        </TabsTrigger>
        <TabsTrigger
          value="preview"
          render={<AppLink to="/app/$appSlug/pull-requests/$prNumber/preview" params={{ prNumber }} />}
        >
          Preview Environment
        </TabsTrigger>
        {isAdmin && (
          <TabsTrigger
            value="usage"
            render={<AppLink to="/app/$appSlug/pull-requests/$prNumber/usage" params={{ prNumber }} />}
          >
            Usage
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  );
}
