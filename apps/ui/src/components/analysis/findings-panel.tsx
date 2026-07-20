import { Badge, Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import type { InvestigationFinding } from "@autonoma/types";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { analysisVerdictMeta, verdictSortKey } from "components/analysis/verdict-meta";
import { useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

/**
 * The authoritative findings list, rendered in the snapshot page's TESTS RUN slot. Every test the analysis ran
 * yields one finding row; each row - client bug, coverage, or passed alike - opens the finding's evidence detail
 * (there is no split by type and no durable Bug page). Actionable findings (client bugs, the only verdict that
 * counts against the PR) are shown by default; the non-blocking coverage + passed rows collapse behind a toggle.
 */
export function AnalysisFindingsPanel({
  findings,
  prNumber,
  snapshotId,
}: {
  findings: InvestigationFinding[];
  prNumber: number;
  snapshotId: string;
}) {
  const [showCollapsed, setShowCollapsed] = useState(false);

  const sorted = [...findings].sort((a, b) => verdictSortKey(a.category) - verdictSortKey(b.category));
  const actionable = sorted.filter((f) => analysisVerdictMeta(f.category).actionable);
  const collapsed = sorted.filter((f) => !analysisVerdictMeta(f.category).actionable);
  const bugCount = findings.filter((f) => f.category === "client_bug").length;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Findings</PanelTitle>
        <span className="font-mono text-2xs text-text-secondary">
          {findings.length} {findings.length === 1 ? "finding" : "findings"}
          {bugCount > 0 ? ` · ${bugCount} ${bugCount === 1 ? "bug" : "bugs"}` : ""}
        </span>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-4">
        {findings.length === 0 ? (
          <p className="text-sm text-text-secondary">No tests were run for this checkpoint.</p>
        ) : (
          <>
            {actionable.length === 0 ? (
              <p className="rounded-lg border border-border-dim bg-surface-void px-5 py-6 text-sm text-text-secondary">
                No client bugs - everything the agent checked passed or was non-blocking.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {actionable.map((finding) => (
                  <FindingRow key={finding.id} finding={finding} prNumber={prNumber} snapshotId={snapshotId} />
                ))}
              </ul>
            )}

            {collapsed.length > 0 && (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setShowCollapsed((prev) => !prev)}
                  className="self-start font-mono text-2xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
                >
                  {showCollapsed ? "Hide" : "Show"} {collapsed.length} more
                </button>
                {showCollapsed && (
                  <ul className="flex flex-col gap-2">
                    {collapsed.map((finding) => (
                      <FindingRow key={finding.id} finding={finding} prNumber={prNumber} snapshotId={snapshotId} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

function FindingRow({
  finding,
  prNumber,
  snapshotId,
}: {
  finding: InvestigationFinding;
  prNumber: number;
  snapshotId: string;
}) {
  const meta = analysisVerdictMeta(finding.category);
  // A merged finding (the Reconciler unioned several tests that hit the same issue) covers > 1 slug.
  const mergedCount = finding.coveredSlugs != null && finding.coveredSlugs.length > 1 ? finding.coveredSlugs.length : 0;
  return (
    <li>
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings/$findingId"
        params={{ prNumber, snapshotId, findingId: finding.id }}
        className="flex items-center gap-4 rounded-lg border border-border-dim bg-surface-void px-4 py-3 transition-colors hover:border-border-mid hover:bg-surface-raised"
      >
        <Badge variant={meta.variant} className="shrink-0 font-mono uppercase">
          {meta.label}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-text-primary">{finding.headline}</p>
          <p className="truncate font-mono text-2xs text-text-secondary">
            {finding.slug}
            {finding.confidence != null ? ` · ${finding.confidence} confidence` : ""}
          </p>
        </div>
        {mergedCount > 0 ? (
          <Badge variant="outline" className="shrink-0">
            seen in {mergedCount} tests
          </Badge>
        ) : null}
        <CaretRightIcon size={14} className="shrink-0 text-text-secondary" />
      </AppLink>
    </li>
  );
}
