import { Badge, Panel, PanelBody } from "@autonoma/blacklight";
import { type AnalysisFlow, analysisFlowComposition } from "@autonoma/types";
import { FLOW_OWNER_META, FLOW_STATUS_META } from "components/analysis/flow-list";
import { useState } from "react";

export function FixFlowsDisclosure({ flows }: { flows: AnalysisFlow[] }) {
  const [open, setOpen] = useState(false);
  if (flows.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="self-start font-mono text-2xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
      >
        {open ? "Hide" : "Show"} what this PR covers
      </button>
      {open && (
        <Panel>
          <PanelBody className="p-0">
            <ul className="divide-y divide-border-dim">
              {flows.map((flow) => (
                <FlowSummaryRow key={flow.title} flow={flow} />
              ))}
            </ul>
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}

function FlowSummaryRow({ flow }: { flow: AnalysisFlow }) {
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
