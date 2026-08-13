import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { Link } from "@tanstack/react-router";
import { PreviewLivenessBadge } from "components/preview-liveness-badge";
import { pickPreviewLiveness, type PreviewLivenessState } from "lib/query/preview-access.queries";

/**
 * Whether the PR's preview is up, and the way in. Nested inside the row's full-bleed link, so the anchor needs
 * its own z-layer and has to stop the click from reaching the row underneath.
 *
 * The link goes through `/preview-waiting` rather than straight at the URL: a sleeping preview needs waking,
 * and that screen is what does it.
 */
export function PRPreviewCell({
  previewUrl,
  liveness,
}: {
  previewUrl?: string;
  liveness?: Record<string, PreviewLivenessState>;
}) {
  if (previewUrl == null) return undefined;

  return (
    <span className="flex min-w-0 items-center gap-2">
      <PreviewLivenessBadge state={pickPreviewLiveness(liveness, [previewUrl])} weight="row" />
      <Link
        to="/preview-waiting"
        search={{ to: previewUrl }}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        aria-label="Open the preview environment"
        className="relative z-10 inline-flex shrink-0 items-center gap-0.5 font-mono text-2xs text-primary-ink hover:underline"
      >
        open
        <ArrowUpRightIcon size={11} weight="bold" />
      </Link>
    </span>
  );
}
