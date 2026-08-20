import { Badge, Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import {
  type AnalysisFindingView,
  type AnalysisFlow,
  type AnalysisFlowStatus,
  analysisFindingSortKey,
  analysisFlowComposition,
} from "@autonoma/types";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { VerdictBadge } from "components/analysis/verdict-badge";
import type * as React from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

type BadgeVariant = NonNullable<React.ComponentProps<typeof Badge>["variant"]>;

/**
 * THE presentation of each flow status. A `Record` over the union, so a new status is a compile error here until it
 * is given copy and a tone, and no surface re-derives its own.
 */
export const FLOW_STATUS_META: Record<AnalysisFlowStatus, { label: string; variant: BadgeVariant }> = {
  broken: { label: "Bug", variant: "critical" },
  verified: { label: "Verified", variant: "success" },
  partial: { label: "Partly verified", variant: "warn" },
  unverified: { label: "Not verified", variant: "neutral" },
};

/**
 * Whose a flow's gaps are - the reader's first question, so it is a real badge rather than a muted one. A flow with
 * no gap has no owner and shows nothing.
 */
export const FLOW_OWNER_META: Record<AnalysisFlow["owner"], { label: string; variant: BadgeVariant } | undefined> = {
  client: { label: "Yours to fix", variant: "warn" },
  autonoma: { label: "On us", variant: "secondary" },
  none: undefined,
};

/**
 * The branch's flow itemization: which parts of the app this PR has established, and which it has not.
 *
 * Ordered as the Reporter clustered them rather than by severity, because a reader looking for one feature should
 * find it where they last saw it. Every judgement rendered here - the status, the owner, the counts - is derived from
 * the tests each flow cites; the Reporter contributes only the name and the sentence.
 *
 * `findings` are only THIS run's findings; a flow can cite tests carried from an earlier checkpoint whose finding does
 * not live at `snapshotId`. A flow shows its findings dropdown ONLY when this run resolves every test it cites, so the
 * dropdown always accounts for the full set the cumulative status and composition above are computed from - a
 * partially-carried flow shows no dropdown rather than one whose contents the header would contradict.
 */
export function AnalysisFlowList({
  flows,
  findings,
  prNumber,
  snapshotId,
}: {
  flows: AnalysisFlow[];
  findings: AnalysisFindingView[];
  prNumber: number;
  snapshotId: string;
}) {
  if (flows.length === 0) return null;

  const findingBySlug = new Map(findings.map((finding) => [finding.testCase.slug, finding]));

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>What this PR covers</PanelTitle>
      </PanelHeader>
      <PanelBody className="p-0">
        <ul className="divide-y divide-border-dim">
          {flows.map((flow) => (
            <FlowRow
              key={flow.title}
              flow={flow}
              findings={resolveFlowFindings(flow, findingBySlug)}
              prNumber={prNumber}
              snapshotId={snapshotId}
            />
          ))}
        </ul>
      </PanelBody>
    </Panel>
  );
}

/**
 * The findings behind one flow, ordered bugs-first via the shared sort key. Only THIS run's findings resolve (see the
 * component doc): a carried-over slug with no finding this run is dropped, so a flow can render fewer rows than its
 * branch-scoped status counts.
 */
function resolveFlowFindings(
  flow: AnalysisFlow,
  findingBySlug: Map<string, AnalysisFindingView>,
): AnalysisFindingView[] {
  return flow.testSlugs
    .map((slug) => findingBySlug.get(slug))
    .filter((finding): finding is AnalysisFindingView => finding != null)
    .sort((a, b) => analysisFindingSortKey(a.category) - analysisFindingSortKey(b.category));
}

function FlowRow({
  flow,
  findings,
  prNumber,
  snapshotId,
}: {
  flow: AnalysisFlow;
  findings: AnalysisFindingView[];
  prNumber: number;
  snapshotId: string;
}) {
  const status = FLOW_STATUS_META[flow.status];
  const owner = FLOW_OWNER_META[flow.owner];
  const composition = analysisFlowComposition(flow);
  // Every cited test resolved to a finding this run, so the dropdown accounts for the whole set the header counts
  // from. When some are carried over (their findings live at an earlier snapshot), show none rather than a subset
  // the cumulative status/composition would contradict.
  const findingsBackHeader = findings.length > 0 && findings.length === flow.testSlugs.length;

  return (
    <li className="flex flex-col gap-1 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={status.variant} className="shrink-0 font-mono text-3xs uppercase tracking-wider">
          {status.label}
        </Badge>
        <span className="text-sm font-medium text-text-primary">{flow.title}</span>
        {composition != null && <span className="font-mono text-3xs text-text-secondary">{composition}</span>}
        {owner != null && (
          <Badge variant={owner.variant} className="ml-auto shrink-0 font-mono text-3xs uppercase tracking-wider">
            {owner.label}
          </Badge>
        )}
      </div>
      <p className="text-xs leading-relaxed text-text-secondary">{flow.detail}</p>
      {findingsBackHeader && <FlowFindings findings={findings} prNumber={prNumber} snapshotId={snapshotId} />}
    </li>
  );
}

/**
 * The flow's individual checks, collapsed by default. Each row is the terminal verdict of one test the flow cites,
 * linking to its finding page - the evidence, trace and self-heal history behind the one-line judgement above.
 */
function FlowFindings({
  findings,
  prNumber,
  snapshotId,
}: {
  findings: AnalysisFindingView[];
  prNumber: number;
  snapshotId: string;
}) {
  return (
    <details className="group mt-1">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-text-secondary transition-colors hover:text-text-primary">
        <CaretRightIcon size={11} className="transition-transform group-open:rotate-90" />
        <span className="font-mono text-3xs font-semibold uppercase tracking-widest">
          {findings.length === 1 ? "1 finding" : `${findings.length} findings`}
        </span>
      </summary>
      <ul className="mt-1.5 flex flex-col gap-0.5 border-l border-border-dim pl-3">
        {findings.map((finding) => (
          <FlowFindingRow key={finding.id} finding={finding} prNumber={prNumber} snapshotId={snapshotId} />
        ))}
      </ul>
    </details>
  );
}

function FlowFindingRow({
  finding,
  prNumber,
  snapshotId,
}: {
  finding: AnalysisFindingView;
  prNumber: number;
  snapshotId: string;
}) {
  return (
    <li>
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings/$findingId"
        params={{ prNumber, snapshotId, findingId: finding.id }}
        className="group/row flex items-center gap-2 py-1 transition-colors hover:text-text-primary"
      >
        <VerdictBadge verdict={finding.category} />
        <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{finding.testCase.name}</span>
        <ArrowUpRightIcon
          size={12}
          className="shrink-0 text-text-secondary transition-colors group-hover/row:text-text-primary"
        />
      </AppLink>
    </li>
  );
}
