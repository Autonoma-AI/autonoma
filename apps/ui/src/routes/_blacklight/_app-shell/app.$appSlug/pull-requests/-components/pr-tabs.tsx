import { Tabs, TabsList, TabsTrigger } from "@autonoma/blacklight";
import { usePreviewEnvironmentSummary } from "lib/query/deployments.queries";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export type PRTab = "overview" | "preview";

// The PR-page tab bar. Rendered only for PRs backed by a real previewkit_environment: a non-preview
// PR (BYO deploy, or none) renders the overview alone with no tab bar. When a preview exists,
// Overview + Preview are shown as line tabs.
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
  if (summary.source !== "previewkit") return null;

  return (
    <div className="border-b border-border-dim bg-surface-void px-6">
      <Tabs value={active}>
        <TabsList variant="line">
          <TabsTrigger
            value="overview"
            render={<AppLink to="/app/$appSlug/pull-requests/$prNumber" params={{ prNumber }} />}
          >
            PR Analysis
          </TabsTrigger>
          <TabsTrigger
            value="preview"
            render={<AppLink to="/app/$appSlug/pull-requests/$prNumber/preview" params={{ prNumber }} />}
          >
            Preview Environment
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
