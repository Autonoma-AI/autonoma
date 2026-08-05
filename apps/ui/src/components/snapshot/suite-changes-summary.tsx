import { Badge } from "@autonoma/blacklight";
import { Link } from "@tanstack/react-router";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import type { SnapshotDetail } from "./snapshot-types";

interface SummaryEntry {
  testCaseId: string;
  testName: string;
}

interface SuiteChangesSummaryProps {
  detail: SnapshotDetail;
  prNumber: number;
}

/**
 * At-a-glance rollup of what this snapshot did to the suite: tests created
 * (authored by the diffs agent during analysis) and removed (culled by
 * healing). Each test links to its entry in the test-suite-changes view.
 */
export function SuiteChangesSummary({ detail, prNumber }: SuiteChangesSummaryProps) {
  const created: SummaryEntry[] = detail.createdTests.map((t) => ({
    testCaseId: t.testCase.id,
    testName: t.testCase.name,
  }));
  const removed: SummaryEntry[] = detail.changes
    .filter((c) => c.type === "removed")
    .map((c) => ({ testCaseId: c.testCaseId, testName: c.testCaseName }));

  if (created.length === 0 && removed.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 border border-border-dim bg-surface-base px-5 py-4">
      <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
        Suite changes this snapshot
      </h3>
      <div className="grid grid-cols-1 gap-px bg-border-dim sm:grid-cols-2">
        <SummaryGroup
          label="Created"
          variant="success"
          entries={created}
          prNumber={prNumber}
          snapshotId={detail.snapshot.id}
        />
        <SummaryGroup
          label="Removed"
          variant="critical"
          entries={removed}
          prNumber={prNumber}
          snapshotId={detail.snapshot.id}
        />
      </div>
    </div>
  );
}

function SummaryGroup({
  label,
  variant,
  entries,
  prNumber,
  snapshotId,
}: {
  label: string;
  variant: "success" | "critical";
  entries: SummaryEntry[];
  prNumber: number;
  snapshotId: string;
}) {
  const app = useCurrentApplication();

  return (
    <div className="flex flex-col gap-2 bg-surface-base p-3">
      <div className="flex items-center gap-2">
        <Badge variant={variant} className="text-3xs">
          {label}
        </Badge>
        <span className="font-mono text-2xs text-text-secondary">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <span className="text-2xs text-text-secondary">None</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.map((entry) => (
            <li key={entry.testCaseId} className="min-w-0">
              <Link
                to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/changes/$testId"
                params={{ appSlug: app.slug, prNumber, snapshotId, testId: entry.testCaseId }}
                className="block truncate font-mono text-xs text-text-primary hover:underline"
              >
                {entry.testName}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
