import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { AppLink } from "../../-app-link";

export function HomeHeader({ appName, architecture }: { appName: string; architecture: string }) {
  return (
    <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-border-dim px-6 py-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-primary">Application overview</h1>
        <p className="mt-1 font-mono text-[11px] text-text-tertiary">
          {appName} / {architecture.toLowerCase()} · what is in flight, and what is broken on main
        </p>
      </div>
      <AppLink
        to="/app/$appSlug/pull-requests"
        className="inline-flex items-center gap-1.5 font-mono text-[11px] text-text-secondary transition-colors hover:text-text-primary"
      >
        All pull requests
        <ArrowRightIcon size={12} weight="bold" />
      </AppLink>
    </header>
  );
}
