import { type InlineEvidence, ReasoningMarkdown } from "components/snapshot/reasoning-block";
import type { RouterOutputs } from "lib/trpc";

type BugDetail = RouterOutputs["bugs"]["detail"];
type BugReport = BugDetail["report"];

// "Why this is a bug". For healing-authored bugs this is an Expected vs Actual block (the
// backbone claim) followed by the rich markdown narrative from the report. Bugs whose
// report == null predate the report spine; for those we render bug.description as the
// narrative and latestOccurrence.whatHappened as the Actual claim, so the section is never
// empty when that data exists. Renders nothing only when there is neither a report nor any
// fallback prose to show.
export function BugWhySection({
  report,
  description,
  whatHappened,
}: {
  report: BugReport;
  description: string;
  whatHappened?: string;
}) {
  if (report != null) {
    return (
      <WhySection>
        <ExpectedActual expected={report.expectedBehavior} actual={report.actualBehavior} />
        {report.narrativeMarkdown.trim().length > 0 && (
          <NarrativeBlock content={report.narrativeMarkdown} evidence={report.evidence} />
        )}
      </WhySection>
    );
  }

  const hasWhatHappened = whatHappened != null && whatHappened.trim().length > 0;
  const narrative = normalizeBugDescriptionMarkdown(description);
  if (!hasWhatHappened && narrative.length === 0) return null;

  return (
    <WhySection>
      {hasWhatHappened && <Claim tone="actual" label="Actual" body={whatHappened} />}
      {narrative.length > 0 && <NarrativeBlock content={narrative} />}
    </WhySection>
  );
}

function WhySection({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Why this is a bug</h2>
      {children}
    </section>
  );
}

function NarrativeBlock({ content, evidence }: { content: string; evidence?: InlineEvidence[] }) {
  return (
    <div className="border border-border-dim bg-surface-base px-4 py-3">
      <ReasoningMarkdown content={content} evidence={evidence} />
    </div>
  );
}

function ExpectedActual({ expected, actual }: { expected?: string; actual: string }) {
  const hasExpected = expected != null && expected.trim().length > 0;

  if (!hasExpected) {
    return <Claim tone="actual" label="Actual" body={actual} />;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Claim tone="expected" label="Expected" body={expected} />
      <Claim tone="actual" label="Actual" body={actual} />
    </div>
  );
}

function Claim({ tone, label, body }: { tone: "expected" | "actual"; label: string; body: string }) {
  const labelColor = tone === "expected" ? "text-status-success" : "text-status-critical";
  return (
    <div className="flex flex-col gap-2 border border-border-dim bg-surface-base px-4 py-3">
      <span className={`font-mono text-2xs uppercase tracking-widest ${labelColor}`}>{label}</span>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{body}</p>
    </div>
  );
}

// Bug descriptions are free-form model prose, sometimes with headers glued onto the
// preceding line ("...done. ## Affected files - a.ts"). Re-break those so ReasoningMarkdown
// renders headers as headers rather than as literal text.
function normalizeBugDescriptionMarkdown(description: string): string {
  return description
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/[ \t]+(#{1,6}\s+)/g, "\n\n$1")
    .replace(/(^|\n)(#{1,6}\s+Affected files)\s*[-:]\s*/gi, "$1$2\n\n")
    .replace(/(^|\n)(#{1,6}\s+Suggested fix)\s+/gi, "$1$2\n\n");
}
