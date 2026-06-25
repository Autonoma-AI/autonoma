import { Badge, cn, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { ShieldWarningIcon } from "@phosphor-icons/react/ShieldWarning";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { ReasoningMarkdown } from "./reasoning-block";
import { CATEGORY, type TestEntry } from "./snapshot-entries";
import { useChangesDetailParams } from "./use-changes-params";
import { useSnapshotEntry } from "./use-snapshot-sections";

const QUARANTINE_REASON: Record<
  "application_bug" | "engine_limitation",
  { label: string; variant: "critical" | "high"; hint: string }
> = {
  application_bug: {
    label: "application bug",
    variant: "critical",
    hint: "Quarantined because a bug in the application makes this test fail.",
  },
  engine_limitation: {
    label: "engine limitation",
    variant: "high",
    hint: "Quarantined because the test engine cannot reliably execute this test.",
  },
};

const RUN_STATUS_BADGE: Record<string, "status-pending" | "status-running" | "status-passed" | "status-failed"> = {
  pending: "status-pending",
  running: "status-running",
  success: "status-passed",
  failed: "status-failed",
};

const GENERATION_STATUS_BADGE: Record<string, "status-pending" | "status-running" | "status-passed" | "status-failed"> =
  {
    pending: "status-pending",
    queued: "status-pending",
    running: "status-running",
    success: "status-passed",
    failed: "status-failed",
  };

export function SnapshotChangesDetail() {
  const { snapshotId, testId } = useChangesDetailParams();
  const entry = useSnapshotEntry(snapshotId, testId);

  if (entry == null) {
    return (
      <div className="flex h-full items-center justify-center px-5 py-10">
        <p className="text-xs text-text-tertiary">Test not found in this checkpoint&apos;s changes.</p>
      </div>
    );
  }

  return <TestEntryDetail entry={entry} />;
}

function TestEntryDetail({ entry }: { entry: TestEntry }) {
  const app = useCurrentApplication();
  const { prNumber } = useChangesDetailParams();
  const generationFailed = entry.generation?.status === "failed";
  const showRun = entry.run != null && !generationFailed;

  return (
    <article className="flex flex-col">
      <header className="flex flex-col gap-2 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 leading-none">
          <Badge variant={CATEGORY[entry.category].variant}>{CATEGORY[entry.category].label}</Badge>
          <span className="min-w-0 font-mono text-sm text-text-primary">{entry.testName}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {entry.testSlug != null && (
            <Link
              to="/app/$appSlug/pull-requests/$prNumber/suite"
              params={{ appSlug: app.slug, prNumber }}
              search={{ testSlug: entry.testSlug }}
              className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-widest text-text-tertiary transition-colors hover:text-text-primary hover:underline"
            >
              <ArrowSquareOutIcon size={11} />
              View in active suite
            </Link>
          )}
          {entry.quarantine != null && <DetailQuarantine quarantine={entry.quarantine} />}
        </div>
      </header>

      {entry.reasoning != null && entry.reasoning.trim().length > 0 && (
        <DetailSection label={reasoningLabel(entry.category)}>
          <Prose>{entry.reasoning}</Prose>
        </DetailSection>
      )}
      {entry.plan != null && entry.plan.trim().length > 0 && (
        <DetailSection label="Plan">
          <ClampedProse>{entry.plan}</ClampedProse>
        </DetailSection>
      )}
      {entry.previousPlan != null && entry.previousPlan.trim().length > 0 && (
        <DetailSection label="Previous plan">
          <ClampedProse className="text-text-secondary">{entry.previousPlan}</ClampedProse>
        </DetailSection>
      )}
      {entry.generation != null && (
        <DetailSection
          label="Generation"
          headerExtras={<GenerationActions generation={entry.generation} />}
          reasoning={entry.generation.reviewReasoning}
        />
      )}
      {showRun && entry.run != null && (
        <DetailSection
          label="Run"
          headerExtras={<RunActions run={entry.run} />}
          reasoning={entry.run.reviewReasoning}
        />
      )}
    </article>
  );
}

function reasoningLabel(category: TestEntry["category"]): string {
  if (category === "added") return "Why existing tests do not cover this";
  if (category === "checked") return "Why this was checked";
  return "Why this changed";
}

function DetailSection({
  label,
  headerExtras,
  reasoning,
  children,
}: {
  label: string;
  headerExtras?: React.ReactNode;
  reasoning?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-border-dim px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</h4>
        {headerExtras}
      </div>
      {children}
      {reasoning != null && reasoning.trim().length > 0 && <Prose>{reasoning}</Prose>}
    </section>
  );
}

function DetailQuarantine({ quarantine }: { quarantine: NonNullable<TestEntry["quarantine"]> }) {
  const reason = QUARANTINE_REASON[quarantine.reason];
  return (
    <div className="inline-flex items-center gap-1.5">
      <ShieldWarningIcon size={12} className="text-status-high" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge variant={reason.variant} className="text-3xs">
              {reason.label}
            </Badge>
          }
        />
        <TooltipContent>{reason.hint}</TooltipContent>
      </Tooltip>
      {quarantine.bugId != null ? (
        <AppLink
          to="/app/$appSlug/bugs/$bugId"
          params={{ bugId: quarantine.bugId }}
          className="font-mono text-2xs uppercase tracking-widest text-text-tertiary hover:text-text-primary hover:underline"
        >
          View bug
        </AppLink>
      ) : (
        <AppLink
          to="/app/$appSlug/issues/$issueId"
          params={{ issueId: quarantine.issueId }}
          className="font-mono text-2xs uppercase tracking-widest text-text-tertiary hover:text-text-primary hover:underline"
        >
          View issue
        </AppLink>
      )}
    </div>
  );
}

function GenerationActions({ generation }: { generation: NonNullable<TestEntry["generation"]> }) {
  const variant = GENERATION_STATUS_BADGE[generation.status] ?? "status-pending";
  return (
    <>
      <Badge variant={variant}>{generation.status}</Badge>
      <AppLink
        to="/app/$appSlug/generations/$generationId"
        params={{ generationId: generation.id }}
        className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-widest text-text-tertiary hover:text-text-primary hover:underline"
      >
        <ArrowSquareOutIcon size={11} />
        View
      </AppLink>
    </>
  );
}

function RunActions({ run }: { run: NonNullable<TestEntry["run"]> }) {
  const variant = RUN_STATUS_BADGE[run.status] ?? "status-pending";
  return (
    <>
      <Badge variant={variant}>{run.status}</Badge>
      {run.verdict != null && (
        <Badge variant={run.verdict === "application_bug" ? "critical" : "warn"}>
          {run.verdict === "application_bug" ? "app bug" : run.verdict.replace("_", " ")}
        </Badge>
      )}
      <AppLink
        to="/app/$appSlug/runs/$runId"
        params={{ runId: run.id }}
        className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-widest text-text-tertiary hover:text-text-primary hover:underline"
      >
        <ArrowSquareOutIcon size={11} />
        View
      </AppLink>
    </>
  );
}

function Prose({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`whitespace-pre-wrap text-xs leading-relaxed text-text-primary ${className ?? ""}`}>{children}</p>
  );
}

// Renders a markdown test plan, collapsed to a fixed height with a "Read more" toggle.
function ClampedProse({ children, className }: { children: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el == null) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [children]);

  const showToggle = overflowing || expanded;

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div ref={ref} className={cn("w-full overflow-hidden", !expanded && "max-h-36", className)}>
        <ReasoningMarkdown content={children} />
      </div>
      {showToggle && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="font-mono text-2xs uppercase tracking-widest text-text-tertiary transition-colors hover:text-text-primary"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
