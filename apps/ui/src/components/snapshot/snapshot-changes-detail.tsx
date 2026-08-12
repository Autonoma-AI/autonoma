import { Badge, Diff, cn } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { Link } from "@tanstack/react-router";
import { analysisVerdictMeta } from "components/analysis/verdict-meta";
import { useSnapshotAnalysisState } from "lib/query/branches.queries";
import { useEffect, useRef, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { ReasoningMarkdown } from "./reasoning-block";
import { CATEGORY, type TestEntry } from "./snapshot-entries";
import { useChangesDetailParams } from "./use-changes-params";
import { useSnapshotEntry } from "./use-snapshot-sections";

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
  const { settled: isAuthoritative } = useSnapshotAnalysisState(snapshotId);

  if (entry == null) {
    return (
      <div className="flex h-full items-center justify-center px-5 py-10">
        <p className="text-xs text-text-tertiary">Test not found in this checkpoint&apos;s changes.</p>
      </div>
    );
  }

  return <TestEntryDetail entry={entry} isAuthoritative={isAuthoritative} />;
}

function TestEntryDetail({ entry, isAuthoritative }: { entry: TestEntry; isAuthoritative: boolean }) {
  const app = useCurrentApplication();
  const { prNumber } = useChangesDetailParams();

  const reasoningSection = entry.reasoning != null && entry.reasoning.trim().length > 0 && (
    <DetailSection label={reasoningLabel(entry.category)}>
      <Prose>{entry.reasoning}</Prose>
    </DetailSection>
  );
  const plan = nonEmpty(entry.plan);
  const previousPlan = nonEmpty(entry.previousPlan);

  const planSection = plan != null && <PlanSection plan={plan} previousPlan={previousPlan} />;
  // A previous plan with no current one means the test was dropped; there is
  // nothing to diff it against, so it stands on its own.
  const previousPlanSection = plan == null && previousPlan != null && (
    <DetailSection label="Previous plan">
      <ClampedProse className="text-text-secondary">{previousPlan}</ClampedProse>
    </DetailSection>
  );
  const generationSection = entry.generation != null && (
    <DetailSection label="Generation" headerExtras={<GenerationActions generation={entry.generation} />} />
  );
  const verdictSection = entry.verdict != null && (
    <DetailSection
      label="Verdict"
      headerExtras={<VerdictActions verdict={entry.verdict} />}
      reasoning={verdictProse(entry.verdict)}
    />
  );

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
        </div>
      </header>

      {/* Authoritative snapshots lead with what the run concluded, then why the test was selected, then the plan. */}
      {isAuthoritative ? (
        <>
          {verdictSection}
          {reasoningSection}
          {planSection}
          {previousPlanSection}
        </>
      ) : (
        <>
          {reasoningSection}
          {planSection}
          {previousPlanSection}
          {generationSection}
        </>
      )}
    </article>
  );
}

/** The verdict's own account of the run, noting when the run rewrote the plan and re-ran to get there. */
function verdictProse(verdict: NonNullable<TestEntry["verdict"]>): string {
  if (verdict.selfHealed !== true) return verdict.headline;
  return `${verdict.headline}\n\nThe plan was rewritten and re-run before this verdict was reached.`;
}

/** The verdict badge plus links to the full finding (evidence, trace, video) and the run that produced it. */
function VerdictActions({ verdict }: { verdict: NonNullable<TestEntry["verdict"]> }) {
  const { prNumber, snapshotId } = useChangesDetailParams();
  const meta = analysisVerdictMeta(verdict.category);

  return (
    <>
      <Badge variant={meta.variant}>{meta.label}</Badge>
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings/$findingId"
        params={{ prNumber, snapshotId, findingId: verdict.findingId }}
        className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-widest text-text-secondary hover:text-text-primary hover:underline"
      >
        <ArrowSquareOutIcon size={11} />
        Finding
      </AppLink>
      <AppLink
        to="/app/$appSlug/generations/$generationId"
        params={{ generationId: verdict.generationId }}
        className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-widest text-text-secondary hover:text-text-primary hover:underline"
      >
        <ArrowSquareOutIcon size={11} />
        Generation
      </AppLink>
    </>
  );
}

/**
 * The test's plan. When the checkpoint rewrote it, the previous version is one
 * toggle away as a diff: the two are near-identical prose, and the edit that
 * matters is usually a couple of words no reader would spot side by side.
 */
function PlanSection({ plan, previousPlan }: { plan: string; previousPlan?: string }) {
  const [showDiff, setShowDiff] = useState(false);

  if (previousPlan == null) {
    return (
      <DetailSection label="Plan">
        <ClampedProse>{plan}</ClampedProse>
      </DetailSection>
    );
  }

  return (
    <DetailSection
      label="Plan"
      headerExtras={
        <div className="flex items-center gap-1 font-mono text-2xs uppercase tracking-widest">
          {[
            { label: "Current", diff: false },
            { label: "Diff", diff: true },
          ].map(({ label, diff }) => (
            <button
              key={label}
              type="button"
              onClick={() => setShowDiff(diff)}
              className={cn(
                "px-1 transition-colors hover:text-text-primary",
                showDiff === diff ? "text-text-primary underline" : "text-text-secondary",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      {showDiff ? (
        <Diff oldSource={previousPlan} newSource={plan} showLineNumbers={false} />
      ) : (
        <ClampedProse>{plan}</ClampedProse>
      )}
    </DetailSection>
  );
}

/** The trimmed text, or `undefined` when it is absent or blank. */
function nonEmpty(text?: string): string | undefined {
  const trimmed = text?.trim();
  return trimmed != null && trimmed.length > 0 ? trimmed : undefined;
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
