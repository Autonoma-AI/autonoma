import { Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import type { InvestigationFinding, ResolvedEvidenceAsset } from "@autonoma/types";
import { ReasoningMarkdown } from "components/snapshot/reasoning-block";
import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

/**
 * The Reporter's holistic PR report prose - the hero of the PR page and the snapshot per-job view. Renders the
 * Markdown with its inline tokens resolved: `evidence:<assetId>` images against the report's signed evidence, and
 * `issue:<id>` / `finding:<slug>` links against this PR's known issues and this report's findings. A token that
 * references an unknown id/slug renders as plain text (a fabricated reference resolves to nothing).
 */
export function AnalysisReportProse({
  markdown,
  evidence,
  prNumber,
  snapshotId,
  findings,
  issueIds,
}: {
  markdown: string;
  evidence: ResolvedEvidenceAsset[];
  prNumber: number;
  snapshotId: string;
  findings: InvestigationFinding[];
  /** The ids of issues this PR knows about, so a token to a real issue links and a fabricated one stays text. */
  issueIds: ReadonlySet<string>;
}) {
  // A `finding:<slug>` token resolves to the finding-detail routing id (its `findingKey`); a merged finding is
  // reachable by any of its covered slugs.
  const findingIdBySlug = new Map<string, string>();
  for (const finding of findings) {
    findingIdBySlug.set(finding.slug, finding.id);
    for (const covered of finding.coveredSlugs ?? []) findingIdBySlug.set(covered, finding.id);
  }

  const renderIssueLink = (issueId: string, children: ReactNode): ReactNode => {
    if (!issueIds.has(issueId)) return children;
    return (
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/issues/$issueId"
        params={{ prNumber, issueId }}
        className="text-primary hover:underline"
      >
        {children}
      </AppLink>
    );
  };

  const renderFindingLink = (slug: string, children: ReactNode): ReactNode => {
    const findingId = findingIdBySlug.get(slug);
    if (findingId == null) return children;
    return (
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings/$findingId"
        params={{ prNumber, snapshotId, findingId }}
        className="text-primary hover:underline"
      >
        {children}
      </AppLink>
    );
  };

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Report</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <ReasoningMarkdown
          content={markdown}
          evidence={evidence}
          renderIssueLink={renderIssueLink}
          renderFindingLink={renderFindingLink}
        />
      </PanelBody>
    </Panel>
  );
}
