import { Badge, StatusDot } from "@autonoma/blacklight";
import { type AnalysisFlow, type AnalysisFlowStatus, analysisFlowComposition } from "@autonoma/types";
import type * as React from "react";

type BadgeVariant = NonNullable<React.ComponentProps<typeof Badge>["variant"]>;
type DotStatus = NonNullable<React.ComponentProps<typeof StatusDot>["status"]>;

/**
 * THE presentation of each flow status. A `Record` over the union, so a new status is a compile error here until it
 * is given copy and a tone, and no surface re-derives its own.
 */
const FLOW_STATUS_META: Record<AnalysisFlowStatus, { label: string; variant: BadgeVariant; dot: DotStatus }> = {
  broken: { label: "Bug", variant: "critical", dot: "critical" },
  verified: { label: "Verified", variant: "success", dot: "success" },
  partial: { label: "Partly verified", variant: "warn", dot: "warn" },
  unverified: { label: "Not verified", variant: "neutral", dot: "neutral" },
};

/** Whose a flow's gaps are. Absent for a flow with no gap at all, which belongs to nobody. */
const FLOW_OWNER_LABEL: Record<AnalysisFlow["owner"], string | undefined> = {
  client: "Yours to fix",
  autonoma: "On us",
  none: undefined,
};

/**
 * The branch's flow itemization: which parts of the app this PR has established, and which it has not.
 *
 * Ordered as the Reporter clustered them rather than by severity, because a reader looking for one feature should
 * find it where they last saw it. Every judgement rendered here - the status, the owner, the counts - is derived from
 * the tests each flow cites; the Reporter contributes only the name and the sentence.
 */
export function AnalysisFlowList({ flows }: { flows: AnalysisFlow[] }) {
  if (flows.length === 0) return null;

  return (
    <div className="flex flex-col border border-border-dim bg-surface-base">
      <div className="border-b border-border-dim px-5 py-3">
        <h3 className="text-sm font-semibold tracking-tight text-text-primary">What this PR covers</h3>
      </div>
      <ul className="divide-y divide-border-dim">
        {flows.map((flow) => (
          <FlowRow key={flow.title} flow={flow} />
        ))}
      </ul>
    </div>
  );
}

/** The page always states the check count; the shared composition adds the mix and the carried note when relevant. */
function describeChecks(flow: AnalysisFlow): string {
  const total = flow.testSlugs.length;
  return analysisFlowComposition(flow) ?? `${total} ${total === 1 ? "check" : "checks"}`;
}

function FlowRow({ flow }: { flow: AnalysisFlow }) {
  const meta = FLOW_STATUS_META[flow.status];
  const owner = FLOW_OWNER_LABEL[flow.owner];

  return (
    <li className="flex flex-col gap-1.5 px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={meta.variant} className="gap-1 font-mono text-3xs uppercase tracking-wider">
          <StatusDot status={meta.dot} />
          {meta.label}
        </Badge>
        <span className="text-sm font-medium text-text-primary">{flow.title}</span>
        {owner != null && (
          <Badge variant="outline" className="font-mono text-3xs">
            {owner}
          </Badge>
        )}
      </div>
      <p className="text-sm text-text-secondary">{flow.detail}</p>
      <p className="font-mono text-3xs text-text-secondary">{describeChecks(flow)}</p>
    </li>
  );
}
