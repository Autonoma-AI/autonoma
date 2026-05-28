import { Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import { createFileRoute } from "@tanstack/react-router";
import type { DiffsJob } from "components/snapshot/diffs-timeline-types";
import { ReasoningMarkdown } from "components/snapshot/reasoning-block";
import { useSnapshotDetail } from "lib/query/branches.queries";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/overview",
)({
  component: OverviewTab,
});

function OverviewTab() {
  const { snapshotId } = Route.useParams();
  const { data } = useSnapshotDetail(snapshotId);
  const { diffsJob } = data;

  return (
    <div className="flex flex-col gap-6">
      <ImpactAnalysisPanel diffsJob={diffsJob} />
      <ResolutionPanel diffsJob={diffsJob} />
    </div>
  );
}

function ImpactAnalysisPanel({ diffsJob }: { diffsJob: DiffsJob }) {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Impact analysis</PanelTitle>
      </PanelHeader>
      <PanelBody>
        {diffsJob.analysisReasoning != null && diffsJob.analysisReasoning.trim().length > 0 ? (
          <ReasoningMarkdown content={diffsJob.analysisReasoning} />
        ) : (
          <p className="text-xs text-text-tertiary">Analysis has not produced a summary yet.</p>
        )}
      </PanelBody>
    </Panel>
  );
}

function ResolutionPanel({ diffsJob }: { diffsJob: DiffsJob }) {
  const hasReasoning = diffsJob.resolutionReasoning != null && diffsJob.resolutionReasoning.trim().length > 0;
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Resolution</PanelTitle>
      </PanelHeader>
      <PanelBody>
        {hasReasoning ? (
          <ReasoningMarkdown content={diffsJob.resolutionReasoning!} />
        ) : (
          <p className="text-xs text-text-tertiary">No resolution has been recorded for this snapshot.</p>
        )}
      </PanelBody>
    </Panel>
  );
}
