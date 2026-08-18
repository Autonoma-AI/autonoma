import {
  Drawer,
  DrawerClose,
  DrawerContent,
  StatusDot,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@autonoma/blacklight";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { XIcon } from "@phosphor-icons/react/X";
import { VerdictBadge } from "components/analysis/verdict-badge";
import { DebugPanel } from "components/debug/debug-panel";
import { formatDuration, formatRelativeTime } from "lib/format";
import { FindingDrawerPlan } from "./finding-drawer-plan";
import { FindingDrawerSteps } from "./finding-drawer-steps";
import { FindingDrawerSummary } from "./finding-drawer-summary";
import { type FindingDetailView, type FindingDrawerTab, availableDrawerTabs } from "./finding-drawer-types";

/**
 * The finding drawer: a non-modal right-edge panel expanding one row of the running stage. URL-driven - the
 * route supplies the resolved view and owns the tab / iteration search params, so every drawer state is a
 * shareable address and closing is just navigating back to the running stage.
 */
export function FindingDrawer({
  view,
  tab,
  onTabChange,
  onIterationChange,
  onClose,
}: {
  view: FindingDetailView;
  /** The requested tab; falls back to the state's default when absent or unavailable. */
  tab?: FindingDrawerTab;
  onTabChange: (tab: FindingDrawerTab) => void;
  onIterationChange: (iteration: number) => void;
  onClose: () => void;
}) {
  const tabs = availableDrawerTabs(view);
  const fallbackTab = tabs[0] ?? "plan";
  const activeTab = tab != null && tabs.includes(tab) ? tab : fallbackTab;
  const classification = view.classification;
  const generation = view.generation;

  return (
    <Drawer side="right" modal={false} open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent side="right" className="flex w-160 max-w-[95vw] flex-col gap-0 overflow-hidden p-0 font-sans">
        <header className="flex shrink-0 flex-col gap-2 border-b border-border-dim px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-base font-semibold text-text-primary">{view.testCase.name}</h2>
            <DrawerClose className="text-text-secondary transition-colors hover:text-text-primary" aria-label="Close">
              <XIcon size={16} />
            </DrawerClose>
          </div>
          {view.testCase.description != null && (
            <p className="text-xs text-text-secondary">{view.testCase.description}</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <FindingStatus view={view} />
            {classification != null && <span className="text-sm text-text-primary">{classification.headline}</span>}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-3xs text-text-secondary">{timingLine(view)}</span>
            {view.iterations.length > 1 && (
              <div className="flex items-center gap-1 font-mono text-3xs text-text-secondary">
                Attempt
                {view.iterations.map((candidate) => (
                  <button
                    key={candidate.number}
                    type="button"
                    onClick={() => onIterationChange(candidate.number)}
                    className={cn(
                      "border px-1.5 py-0.5 transition-colors",
                      candidate.number === classification?.number
                        ? "border-primary text-primary"
                        : "border-border-dim text-text-secondary hover:text-text-primary",
                    )}
                  >
                    {candidate.number}
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>

        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const next = tabs.find((candidate) => candidate === value);
            if (next != null) onTabChange(next);
          }}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList variant="default" className="w-full shrink-0 border-b border-border-dim px-5">
            {tabs.includes("summary") && <TabsTrigger value="summary">Summary</TabsTrigger>}
            {tabs.includes("steps") && <TabsTrigger value="steps">Steps</TabsTrigger>}
            <TabsTrigger value="plan">Plan</TabsTrigger>
            {tabs.includes("debug") && <TabsTrigger value="debug">Debug · admin</TabsTrigger>}
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {classification != null && (
              <TabsContent value="summary">
                <FindingDrawerSummary classification={classification} generation={generation ?? undefined} />
              </TabsContent>
            )}
            {generation != null && (
              <TabsContent value="steps">
                <FindingDrawerSteps generation={generation} />
              </TabsContent>
            )}
            <TabsContent value="plan">
              <FindingDrawerPlan plan={view.plan} previousPlan={view.previousPlan ?? undefined} />
            </TabsContent>
            {generation?.debug != null && (
              <TabsContent value="debug" className="flex flex-col gap-4">
                <DebugPanel debug={generation.debug} conversationUrl={generation.conversationUrl ?? undefined} />
                {generation.temporalWorkflow != null && (
                  <p className="font-mono text-3xs text-text-secondary">
                    Temporal: {generation.temporalWorkflow.workflowId}
                  </p>
                )}
              </TabsContent>
            )}
          </div>
        </Tabs>
      </DrawerContent>
    </Drawer>
  );
}

function FindingStatus({ view }: { view: FindingDetailView }) {
  if (view.classification != null) return <VerdictBadge verdict={view.classification.category} />;
  if (view.contained) {
    return <span className="text-xs text-status-high">Investigation crashed</span>;
  }
  if (view.generation?.status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-status-warn">
        <CircleNotchIcon size={12} className="animate-spin" /> Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
      <StatusDot status="neutral" /> Queued
    </span>
  );
}

function timingLine(view: FindingDetailView): string {
  const generation = view.generation;
  if (generation == null) return "Not started yet";
  const started = `Started ${formatRelativeTime(generation.startedAt)}`;
  const duration =
    generation.completedAt != null
      ? ` · ran for ${formatDuration(generation.completedAt.getTime() - generation.startedAt.getTime())}`
      : "";
  const confidence = view.classification?.confidence != null ? ` · ${view.classification.confidence} confidence` : "";
  return `${started}${duration}${confidence}`;
}
