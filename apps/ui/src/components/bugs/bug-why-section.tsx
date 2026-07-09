import { ReasoningMarkdown } from "components/snapshot/reasoning-block";
import type { RouterOutputs } from "lib/trpc";

type BugDetail = RouterOutputs["bugs"]["detail"];
type BugReport = BugDetail["report"];

// "Why this is a bug" - the healing-authored case. An Expected vs Actual block
// (the backbone claim) followed by the rich markdown narrative. Renders nothing
// when there is no report; degrades to Actual-only when Expected is absent, so we
// never fabricate an Expected the agent did not state.
export function BugWhySection({ report }: { report: BugReport }) {
  if (report == null) return null;

  const hasNarrative = report.narrativeMarkdown.trim().length > 0;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Why this is a bug</h2>
      <ExpectedActual expected={report.expectedBehavior} actual={report.actualBehavior} />
      {hasNarrative && (
        <div className="border border-border-dim bg-surface-base px-4 py-3">
          <ReasoningMarkdown content={report.narrativeMarkdown} evidence={report.evidence} />
        </div>
      )}
    </section>
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
