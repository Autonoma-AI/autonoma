import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { FlaskIcon } from "@phosphor-icons/react/Flask";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { formatDate } from "lib/format";
import type { RouterOutputs } from "lib/trpc";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

type BugDetail = RouterOutputs["bugs"]["detail"];

const QUICK_LINK_CLASS =
  "flex items-center gap-1.5 font-mono text-2xs text-text-secondary transition-colors hover:text-text-primary";

// A single scannable row of facts, so the recurrence signal (occurrence count, first/last
// seen, regressed status) and ownership stay visible without the removed sidebar.
export function BugMetaStrip({ bug }: { bug: BugDetail }) {
  const latest = bug.latestOccurrence;
  const testSlug = latest?.testSlug ?? bug.testCases[0]?.slug;
  const testLabel = bug.testCases[0]?.name ?? testSlug;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border border-border-dim bg-surface-base px-4 py-3">
      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Fact label="Severity" value={bug.severity} />
        <Fact label="Status" value={bug.status} />
        <Fact label="First seen" value={formatDate(bug.firstSeenAt)} />
        <Fact label="Last seen" value={formatDate(bug.lastSeenAt)} />
        <Fact label="Occurrences" value={String(bug.occurrences.length)} />
        <Fact label="App" value={bug.application.name} />
        {testLabel != null && <Fact label="Test" value={testLabel} />}
      </dl>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {testSlug != null && (
          <AppLink to="/app/$appSlug/tests/$testSlug" params={{ testSlug }} className={QUICK_LINK_CLASS}>
            <FlaskIcon size={12} />
            View test
            <ArrowSquareOutIcon size={11} />
          </AppLink>
        )}
        {latest?.runId != null && (
          <AppLink to="/app/$appSlug/runs/$runId" params={{ runId: latest.runId }} className={QUICK_LINK_CLASS}>
            <PlayIcon size={12} />
            View run
            <ArrowSquareOutIcon size={11} />
          </AppLink>
        )}
        {latest?.generationId != null && (
          <AppLink
            to="/app/$appSlug/generations/$generationId"
            params={{ generationId: latest.generationId }}
            className={QUICK_LINK_CLASS}
          >
            <SparkleIcon size={12} />
            View generation
            <ArrowSquareOutIcon size={11} />
          </AppLink>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{label}</dt>
      <dd className="font-mono text-2xs text-text-primary">{value}</dd>
    </div>
  );
}
