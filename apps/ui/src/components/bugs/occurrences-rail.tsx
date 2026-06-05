import { Badge, Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import { formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";
import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

type BugDetail = RouterOutputs["bugs"]["detail"];
type BugOccurrence = BugDetail["occurrences"][number];

interface PrGroup {
  prNumber: number;
  branchName: string | undefined;
  latestSnapshotId: string | undefined;
  lastSeenAt: Date;
  occurrences: BugOccurrence[];
}

// Occurrences arrive newest-first, so the first one we see per PR is the latest.
function groupOccurrencesByPr(occurrences: BugOccurrence[]): { prGroups: PrGroup[]; unlinked: BugOccurrence[] } {
  const groups = new Map<number, PrGroup>();
  const unlinked: BugOccurrence[] = [];

  for (const occurrence of occurrences) {
    if (occurrence.prNumber == null) {
      unlinked.push(occurrence);
      continue;
    }
    const existing = groups.get(occurrence.prNumber);
    if (existing == null) {
      groups.set(occurrence.prNumber, {
        prNumber: occurrence.prNumber,
        branchName: occurrence.branchName,
        latestSnapshotId: occurrence.snapshotId,
        lastSeenAt: occurrence.createdAt,
        occurrences: [occurrence],
      });
      continue;
    }
    existing.occurrences.push(occurrence);
  }

  return { prGroups: [...groups.values()], unlinked };
}

export function OccurrencesRail({ bug }: { bug: BugDetail }) {
  const { prGroups, unlinked } = groupOccurrencesByPr(bug.occurrences);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Occurrences</PanelTitle>
        <span className="font-mono text-2xs text-text-tertiary">{bug.occurrences.length}</span>
      </PanelHeader>
      <PanelBody className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-text-tertiary">
          Each occurrence is one review that linked this behavior to the bug, grouped by the PR it was found in.
        </p>
        {bug.occurrences.length === 0 ? (
          <p className="text-xs text-text-tertiary">No occurrences recorded for this bug yet.</p>
        ) : (
          <div className="space-y-2">
            {prGroups.map((group) => (
              <PrGroupCard key={group.prNumber} group={group} />
            ))}
            {unlinked.length > 0 && (
              <div className="space-y-2">
                {prGroups.length > 0 && (
                  <p className="pt-1 font-mono text-3xs uppercase tracking-widest text-text-tertiary">
                    Not linked to a PR
                  </p>
                )}
                {unlinked.map((occurrence) => (
                  <OccurrenceLink key={occurrence.issueId} occurrence={occurrence} className={STANDALONE_ROW}>
                    <OccurrenceRowContent occurrence={occurrence} />
                  </OccurrenceLink>
                ))}
              </div>
            )}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

const STANDALONE_ROW = "block border border-border-dim p-3 transition hover:border-border hover:bg-surface-raised";

function PrGroupCard({ group }: { group: PrGroup }) {
  const onlyOccurrence = group.occurrences.length === 1 ? group.occurrences[0] : undefined;

  if (onlyOccurrence != null) {
    return (
      <OccurrenceLink occurrence={onlyOccurrence} className={STANDALONE_ROW}>
        <CombinedRowContent group={group} occurrence={onlyOccurrence} />
      </OccurrenceLink>
    );
  }

  return (
    <div className="border border-border-dim">
      <PrLink group={group} className="flex items-center justify-between gap-3 p-3 transition hover:bg-surface-raised">
        <div className="min-w-0">
          <p className="font-mono text-xs text-text-primary">#{group.prNumber}</p>
          {group.branchName != null && <p className="truncate text-xs text-text-tertiary">{group.branchName}</p>}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-text-tertiary">{formatRelativeTime(group.lastSeenAt)}</p>
          <p className="font-mono text-3xs uppercase text-primary">{group.occurrences.length} occurrences</p>
        </div>
      </PrLink>
      <div className="space-y-2 border-t border-border-dim p-2">
        {group.occurrences.map((occurrence) => (
          <OccurrenceLink
            key={occurrence.issueId}
            occurrence={occurrence}
            className="block border border-border-dim p-2 transition hover:border-border hover:bg-surface-raised"
          >
            <OccurrenceRowContent occurrence={occurrence} />
          </OccurrenceLink>
        ))}
      </div>
    </div>
  );
}

function CombinedRowContent({ group, occurrence }: { group: PrGroup; occurrence: BugOccurrence }) {
  return (
    <>
      <div className="flex items-center gap-2">
        {occurrence.isLatest && (
          <Badge variant="secondary" className="font-mono text-3xs">
            latest
          </Badge>
        )}
        <span className="font-mono text-xs text-text-primary">#{group.prNumber}</span>
        {occurrence.sha != null && (
          <span className="font-mono text-xs text-text-secondary">{occurrence.sha.slice(0, 7)}</span>
        )}
      </div>
      {group.branchName != null && <p className="mt-1 truncate text-xs text-text-tertiary">{group.branchName}</p>}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-text-tertiary">{formatRelativeTime(occurrence.createdAt)}</span>
        <span className="font-mono text-3xs uppercase text-primary">{occurrenceLabel(occurrence)}</span>
      </div>
    </>
  );
}

function OccurrenceRowContent({ occurrence }: { occurrence: BugOccurrence }) {
  return (
    <>
      <div className="flex items-center gap-2">
        {occurrence.isLatest && (
          <Badge variant="secondary" className="font-mono text-3xs">
            latest
          </Badge>
        )}
        {occurrence.sha != null && (
          <span className="font-mono text-xs text-text-primary">{occurrence.sha.slice(0, 7)}</span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-xs text-text-tertiary">{formatRelativeTime(occurrence.createdAt)}</span>
        <span className="font-mono text-3xs uppercase text-primary">{occurrenceLabel(occurrence)}</span>
      </div>
    </>
  );
}

function OccurrenceLink({
  occurrence,
  className,
  children,
}: {
  occurrence: BugOccurrence;
  className: string;
  children: ReactNode;
}) {
  if (occurrence.prNumber != null && occurrence.snapshotId != null) {
    return (
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
        params={{ prNumber: occurrence.prNumber, snapshotId: occurrence.snapshotId }}
        className={className}
      >
        {children}
      </AppLink>
    );
  }

  if (occurrence.prNumber != null) {
    return (
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber"
        params={{ prNumber: occurrence.prNumber }}
        className={className}
      >
        {children}
      </AppLink>
    );
  }

  if (occurrence.runId != null) {
    return (
      <AppLink to="/app/$appSlug/runs/$runId" params={{ runId: occurrence.runId }} className={className}>
        {children}
      </AppLink>
    );
  }

  if (occurrence.generationId != null) {
    return (
      <AppLink
        to="/app/$appSlug/generations/$generationId"
        params={{ generationId: occurrence.generationId }}
        className={className}
      >
        {children}
      </AppLink>
    );
  }

  return <div className={className}>{children}</div>;
}

function PrLink({ group, className, children }: { group: PrGroup; className: string; children: ReactNode }) {
  if (group.latestSnapshotId != null) {
    return (
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
        params={{ prNumber: group.prNumber, snapshotId: group.latestSnapshotId }}
        className={className}
      >
        {children}
      </AppLink>
    );
  }

  return (
    <AppLink to="/app/$appSlug/pull-requests/$prNumber" params={{ prNumber: group.prNumber }} className={className}>
      {children}
    </AppLink>
  );
}

function occurrenceLabel(occurrence: BugOccurrence) {
  if (occurrence.prNumber != null && occurrence.snapshotId != null) return "checkpoint";
  if (occurrence.prNumber != null) return "PR";
  return occurrence.source;
}
