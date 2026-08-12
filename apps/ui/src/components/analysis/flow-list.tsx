import { Badge, Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import { type AnalysisFlow, type AnalysisFlowStatus, analysisFlowComposition } from "@autonoma/types";
import type * as React from "react";

type BadgeVariant = NonNullable<React.ComponentProps<typeof Badge>["variant"]>;

/**
 * THE presentation of each flow status. A `Record` over the union, so a new status is a compile error here until it
 * is given copy and a tone, and no surface re-derives its own.
 */
const FLOW_STATUS_META: Record<AnalysisFlowStatus, { label: string; variant: BadgeVariant }> = {
  broken: { label: "Bug", variant: "critical" },
  verified: { label: "Verified", variant: "success" },
  partial: { label: "Partly verified", variant: "warn" },
  unverified: { label: "Not verified", variant: "neutral" },
};

/**
 * Whose a flow's gaps are - the reader's first question, so it is a real badge rather than a muted one. A flow with
 * no gap has no owner and shows nothing.
 */
const FLOW_OWNER_META: Record<AnalysisFlow["owner"], { label: string; variant: BadgeVariant } | undefined> = {
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
 */
export function AnalysisFlowList({ flows }: { flows: AnalysisFlow[] }) {
  if (flows.length === 0) return null;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>What this PR covers</PanelTitle>
      </PanelHeader>
      <PanelBody className="p-0">
        <ul className="divide-y divide-border-dim">
          {flows.map((flow) => (
            <FlowRow key={flow.title} flow={flow} />
          ))}
        </ul>
      </PanelBody>
    </Panel>
  );
}

function FlowRow({ flow }: { flow: AnalysisFlow }) {
  const status = FLOW_STATUS_META[flow.status];
  const owner = FLOW_OWNER_META[flow.owner];
  const composition = analysisFlowComposition(flow);

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
    </li>
  );
}
