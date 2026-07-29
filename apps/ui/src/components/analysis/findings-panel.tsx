import { Badge, Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import {
  type AnalysisFindingTier,
  type AnalysisFindingView,
  analysisFindingSortKey,
  analysisFindingTier,
} from "@autonoma/types";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { analysisVerdictMeta } from "components/analysis/verdict-meta";
import { useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

/**
 * The authoritative findings list, rendered in the snapshot page's TESTS RUN slot. Every test the analysis ran yields
 * one finding row; each row - whatever its verdict - opens the finding's evidence detail (there is no split by type and
 * no durable Bug page).
 *
 * The groups are the taxonomy's `AnalysisFindingTier`s, in its order: the actionable `bug` rows first, then
 * `needs_review` in a visible group (non-blocking, but those tests need a human eye), then `coverage` and `passed`
 * together behind a toggle. Which verdict lands in which tier is the taxonomy's call, never this component's.
 */
export function AnalysisFindingsPanel({
  findings,
  prNumber,
  snapshotId,
}: {
  findings: AnalysisFindingView[];
  prNumber: number;
  snapshotId: string;
}) {
  const [showCollapsed, setShowCollapsed] = useState(false);

  // Grouped by the taxonomy's own presentation tier, never by verdict literals here - so the groups this panel shows
  // are exactly the ones the shared sort key orders by, and cannot drift from the other findings surfaces.
  const sorted = [...findings].sort((a, b) => analysisFindingSortKey(a.category) - analysisFindingSortKey(b.category));
  const byTier = (tier: AnalysisFindingTier) =>
    sorted.filter((finding) => analysisFindingTier(finding.category) === tier);
  const actionable = byTier("bug");
  const needsReview = byTier("needs_review");
  const collapsed = [...byTier("coverage"), ...byTier("passed")];
  const bugCount = actionable.length;

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

            {needsReview.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Needs review</span>
                <ul className="flex flex-col gap-2">
                  {needsReview.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} prNumber={prNumber} snapshotId={snapshotId} />
                  ))}
                </ul>
              </div>
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
  finding: AnalysisFindingView;
  prNumber: number;
  snapshotId: string;
}) {
  const meta = analysisVerdictMeta(finding.category);
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
        <CaretRightIcon size={14} className="shrink-0 text-text-secondary" />
      </AppLink>
    </li>
  );
}
