import { StatusDot, cn, tabsListVariants } from "@autonoma/blacklight";
import type { AnalysisRunView } from "@autonoma/types";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export const ANALYSIS_STAGE_ORDER = ["impact", "running", "report"] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGE_ORDER)[number];

const STAGE_LABELS: Record<AnalysisStage, string> = {
  impact: "Impact analysis",
  running: "Running tests",
  report: "Report",
};

/** Where each stage lives. The one source of truth for the stage URLs - the bare-snapshot index redirect imports it. */
export const STAGE_ROUTES = {
  impact: "/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/impact",
  running: "/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running",
  report: "/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/report",
} as const satisfies Record<AnalysisStage, string>;

type StageIndicatorState = "complete" | "active" | "pending";

/** The stage the run itself is at - what the bare snapshot URL redirects to, and what the indicators mark. */
export function deriveAnalysisStage(run: AnalysisRunView | null, hasReport: boolean): AnalysisStage {
  if (hasReport) return "report";
  const hasRows = run != null && (run.findings.length > 0 || run.removedTests.length > 0);
  return hasRows ? "running" : "impact";
}

/**
 * The staged view's tab bar: `Impact analysis -> Running tests -> Report`, each a real link to its stage URL.
 * Which tab reads active is the router's own match state (the `/running` link stays active over its drawer
 * child routes). `currentStage` is where the run actually is, which only drives the indicator dots - navigation
 * never moves on its own.
 */
export function AnalysisStageTabs({
  prNumber,
  snapshotId,
  currentStage,
  jobRunning,
}: {
  prNumber: number;
  snapshotId: string;
  currentStage: AnalysisStage;
  jobRunning: boolean;
}) {
  return (
    <nav className={cn(tabsListVariants({ variant: "default" }), "flex h-8 w-full")}>
      {ANALYSIS_STAGE_ORDER.map((stage) => (
        <AppLink
          key={stage}
          to={STAGE_ROUTES[stage]}
          params={{ prNumber, snapshotId }}
          className="inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-none border border-transparent px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider whitespace-nowrap transition-all"
          activeProps={{ className: "bg-surface-raised text-foreground" }}
          inactiveProps={{ className: "text-text-secondary hover:text-foreground" }}
        >
          <StageIndicator state={indicatorState(stage, currentStage, jobRunning)} />
          {STAGE_LABELS[stage]}
        </AppLink>
      ))}
    </nav>
  );
}

function StageIndicator({ state }: { state: StageIndicatorState }) {
  if (state === "active") return <CircleNotchIcon size={12} className="animate-spin text-primary" />;
  if (state === "complete") return <StatusDot status="success" />;
  return <StatusDot status="neutral" />;
}

function indicatorState(stage: AnalysisStage, currentStage: AnalysisStage, jobRunning: boolean): StageIndicatorState {
  const position = ANALYSIS_STAGE_ORDER.indexOf(stage);
  const current = ANALYSIS_STAGE_ORDER.indexOf(currentStage);
  if (position < current) return "complete";
  if (position > current) return "pending";
  return jobRunning ? "active" : "complete";
}
