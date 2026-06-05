import { Badge, cn } from "@autonoma/blacklight";
import { formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";
import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

type ExecutedTest = RouterOutputs["branches"]["snapshotDetail"]["executedTests"][number];
type RunStatus = ExecutedTest["status"];
type FinalOutcome = ExecutedTest["finalOutcome"];
type StatusBadgeVariant = "status-pending" | "status-running" | "status-passed" | "status-failed";
type VerdictBadgeVariant = "success" | "warn" | "critical";

interface CheckpointTestsRunProps {
  executedTests: ExecutedTest[];
  totalTests: number;
  maxRows?: number;
  className?: string;
}

export function CheckpointTestsRun({ executedTests, totalTests, maxRows, className }: CheckpointTestsRunProps) {
  if (executedTests.length === 0) {
    return (
      <div className={cn("border border-border-dim bg-surface-void px-4 py-4 text-sm text-text-secondary", className)}>
        {totalTests > 0 ? "No tests were run for this checkpoint" : "No tests are assigned to this checkpoint"}
      </div>
    );
  }

  const orderedTests = TEST_GROUPS.flatMap((group) =>
    executedTests.filter((test) => group.outcomes.includes(test.finalOutcome)),
  );
  const visibleTests = orderedTests.slice(0, maxRows ?? orderedTests.length);
  const hiddenCount = executedTests.length - visibleTests.length;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {TEST_GROUPS.map((group) => {
        const tests = visibleTests.filter((test) => group.outcomes.includes(test.finalOutcome));
        if (tests.length === 0) return null;
        return (
          <div key={group.label} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">
              <span>{group.label}</span>
              <span>·</span>
              <span>{executedTests.filter((test) => group.outcomes.includes(test.finalOutcome)).length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {tests.map((test) => (
                <ExecutedTestRow key={test.testCase.id} test={test} />
              ))}
            </div>
          </div>
        );
      })}

      {hiddenCount > 0 && (
        <div className="border border-border-dim bg-surface-void px-4 py-2 font-mono text-2xs text-text-tertiary">
          Showing {visibleTests.length} of {executedTests.length} tests run
        </div>
      )}
    </div>
  );
}

function ExecutedTestRow({ test }: { test: ExecutedTest }) {
  const reviewReasoning = test.reviewReasoning?.trim() ?? "";
  return (
    <div className="border border-border-dim bg-surface-void px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <TestNameLink test={test} className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" />
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant={FINAL_OUTCOME_BADGE[test.finalOutcome]}>{finalOutcomeLabel(test)}</Badge>
          {test.verdict != null && (
            <Badge variant={VERDICT_BADGE[test.verdict].variant}>{VERDICT_BADGE[test.verdict].label}</Badge>
          )}
        </div>
        <span className="font-mono text-2xs text-text-tertiary">{formatRelativeTime(test.latestRunAt)}</span>
      </div>
      {reviewReasoning.length > 0 && (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-text-primary">{reviewReasoning}</p>
      )}
    </div>
  );
}

function TestNameLink({ test, className }: { test: ExecutedTest; className: string }) {
  const content: ReactNode = test.testCase.name;
  if (test.runId != null) {
    return (
      <AppLink to="/app/$appSlug/runs/$runId" params={{ runId: test.runId }} className={className}>
        {content}
      </AppLink>
    );
  }

  if (test.generationId != null) {
    return (
      <AppLink
        to="/app/$appSlug/generations/$generationId"
        params={{ generationId: test.generationId }}
        className={className}
      >
        {content}
      </AppLink>
    );
  }

  return (
    <AppLink to="/app/$appSlug/tests/$testSlug" params={{ testSlug: test.testCase.slug }} className={className}>
      {content}
    </AppLink>
  );
}

const TEST_GROUPS: Array<{ label: string; outcomes: FinalOutcome[] }> = [
  { label: "Failed", outcomes: ["failed"] },
  { label: "Running", outcomes: ["unresolved"] },
  { label: "Passed", outcomes: ["passed"] },
];

const FINAL_OUTCOME_BADGE: Record<FinalOutcome, StatusBadgeVariant> = {
  unresolved: "status-running",
  passed: "status-passed",
  failed: "status-failed",
};

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  pending: "pending",
  queued: "queued",
  running: "running",
  success: "passed",
  failed: "failed",
};

function finalOutcomeLabel(test: ExecutedTest): string {
  if (test.finalOutcome === "passed") return "passed";
  if (test.finalOutcome === "failed") return "failed";
  return RUN_STATUS_LABEL[test.status];
}

const VERDICT_BADGE: Record<NonNullable<ExecutedTest["verdict"]>, { label: string; variant: VerdictBadgeVariant }> = {
  success: { label: "verified", variant: "success" },
  engine_error: { label: "engine issue", variant: "warn" },
  application_bug: { label: "app bug", variant: "critical" },
  agent_limitation: { label: "agent limitation", variant: "warn" },
  plan_mismatch: { label: "plan mismatch", variant: "warn" },
};
