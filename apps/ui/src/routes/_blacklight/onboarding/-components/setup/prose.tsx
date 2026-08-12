import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-primary-ink">{children}</code>
  );
}

export function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-primary-ink underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

/**
 * `DocLink`'s in-app twin, for the settings surfaces a setup step needs but does
 * not itself contain. Opens in a new tab: these steps run inside the onboarding
 * flow, and navigating away mid-setup is how people used to lose the thread.
 */
export function SettingsLink({
  to,
  appSlug,
  children,
}: {
  to: "/app/$appSlug/settings/api-keys" | "/app/$appSlug/settings/previews";
  appSlug: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      params={{ appSlug }}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-primary-ink underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}
