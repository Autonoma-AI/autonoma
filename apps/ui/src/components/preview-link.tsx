import { isPreviewUrl } from "@autonoma/types";
import { Link } from "@tanstack/react-router";
import { env } from "env";
import type { MouseEventHandler, ReactNode } from "react";

interface PreviewLinkProps {
  /** The preview environment URL to open. */
  url: string;
  children: ReactNode;
  className?: string;
  title?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}

/**
 * A link to a preview environment, always opening in a new tab.
 *
 * Our own previews (`*.preview.<INTERNAL_DOMAIN>`) scale to zero and take ~50s to
 * wake, so a raw link to a sleeping one is a blank tab that reads as broken.
 * Route those through the `/preview-waiting` screen instead - it shows a spinner
 * and ETA and forwards once the preview is serving. Any other URL (e.g. a
 * customer's external/Vercel deploy) is opened directly, since the waiting screen
 * only knows how to wait on Autonoma-hosted previews.
 *
 * This is the one way to render a preview link - reach for it instead of a raw
 * `<a href={previewUrl}>` so a new call site can't forget the waiting screen.
 */
export function PreviewLink({ url, children, className, title, onClick }: PreviewLinkProps) {
  if (isPreviewUrl(url, env.VITE_INTERNAL_DOMAIN)) {
    return (
      <Link
        to="/preview-waiting"
        search={{ to: url }}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        title={title}
        onClick={onClick}
      >
        {children}
      </Link>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={className} title={title} onClick={onClick}>
      {children}
    </a>
  );
}
