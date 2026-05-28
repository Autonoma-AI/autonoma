import { Badge } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { ShieldWarningIcon } from "@phosphor-icons/react/ShieldWarning";
import { Link } from "@tanstack/react-router";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { CATEGORY, type Section } from "./snapshot-entries";

export function SnapshotChangesList({
  sections,
  prNumber,
  snapshotId,
}: {
  sections: Section[];
  prNumber: number;
  snapshotId: string;
}) {
  const app = useCurrentApplication();

  return (
    <nav aria-label="Test suite changes" className="flex flex-col">
      {sections.map((section) => {
        if (section.entries.length === 0) return null;
        return (
          <div key={section.title} className="flex flex-col border-b border-border-dim last:border-b-0">
            <div className="flex items-baseline gap-2 px-3 py-2">
              <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">
                {section.title}
              </h3>
              <Badge variant="outline" className="text-3xs">
                {section.entries.length}
              </Badge>
            </div>
            {section.hint != null && <p className="px-3 pb-2 text-2xs text-text-tertiary">{section.hint}</p>}
            <ul>
              {section.entries.map((entry) => (
                <li key={entry.urlId} className="flex items-stretch border-t border-border-dim/60">
                  <Link
                    to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/changes/$testId"
                    params={{ appSlug: app.slug, prNumber, snapshotId, testId: entry.urlId }}
                    activeProps={{ className: "bg-surface-raised text-text-primary" }}
                    inactiveProps={{ className: "text-text-secondary hover:bg-surface-raised/50" }}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 transition-colors"
                  >
                    <Badge variant={CATEGORY[entry.category].variant} className="shrink-0 text-3xs">
                      {CATEGORY[entry.category].label}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.testName}</span>
                    {entry.quarantine != null && <ShieldWarningIcon size={12} className="shrink-0 text-status-high" />}
                  </Link>
                  {entry.testSlug != null && (
                    <Link
                      to="/app/$appSlug/pull-requests/$prNumber/suite"
                      params={{ appSlug: app.slug, prNumber }}
                      search={{ testSlug: entry.testSlug }}
                      aria-label="Open in active suite"
                      className="flex shrink-0 items-center px-2 text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
                    >
                      <ArrowSquareOutIcon size={12} />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
