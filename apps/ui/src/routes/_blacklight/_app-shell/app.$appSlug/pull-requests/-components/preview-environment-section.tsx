import { Button, StatusDot } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { usePreviewEnvironmentSummary } from "lib/query/deployments.queries";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { PREVIEW_STATUS_META } from "./preview-status-meta";

// Compact preview-environment entry point rendered on the right of the PR header for PRs backed by
// a real previewkit_environment. Renders nothing for legacy/missing previews, and links through to
// the dedicated preview environment page.
export function PreviewEnvironmentHeaderButton({
  applicationId,
  prNumber,
}: {
  applicationId: string;
  prNumber: number;
}) {
  const { data: summary } = usePreviewEnvironmentSummary(applicationId, prNumber);
  if (summary.source !== "previewkit") return null;

  const statusMeta = PREVIEW_STATUS_META[summary.status] ?? PREVIEW_STATUS_META.unknown;

  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0 gap-2"
      render={<AppLink to="/app/$appSlug/preview/$environmentId" params={{ environmentId: summary.environmentId }} />}
    >
      <StatusDot status={statusMeta.dot} className="rounded-full" />
      <span className="font-mono text-2xs font-bold uppercase tracking-wider text-primary-ink">
        Preview Environment
      </span>
      <ArrowRightIcon />
    </Button>
  );
}
