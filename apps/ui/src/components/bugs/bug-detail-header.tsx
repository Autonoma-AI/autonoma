import { Badge, Button, Separator } from "@autonoma/blacklight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import type { RouterOutputs } from "lib/trpc";
import { BugDescription } from "./bug-description";

type BugDetail = RouterOutputs["bugs"]["detail"];

const STATUS_BADGE: Record<string, "status-failed" | "success" | "warn"> = {
  open: "status-failed",
  resolved: "success",
  regressed: "warn",
};

export function BugDetailHeader({
  bug,
  onToggleResolved,
  togglingResolved,
  adminActions,
}: {
  bug: BugDetail;
  onToggleResolved: () => void;
  togglingResolved: boolean;
  adminActions?: React.ReactNode;
}) {
  const latest = bug.latestOccurrence;
  const isResolved = bug.status === "resolved";
  const subtitle = [
    latest?.testSlug,
    latest?.stepIndex != null ? `step ${latest.stepIndex}/${latest.stepCount}` : undefined,
    latest?.actionLabel != null && latest.outcomeLabel != null
      ? `${latest.actionLabel} -> ${latest.outcomeLabel}`
      : latest?.actionLabel,
  ]
    .filter((part) => part != null && part !== "")
    .join(" · ");

  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Bug</span>
          <Badge variant={STATUS_BADGE[bug.status] ?? "secondary"}>{bug.status}</Badge>
          <Badge variant="outline" className="font-mono text-3xs">
            {bug.occurrences.length} occurrences
          </Badge>
          <span className="font-mono text-2xs text-text-tertiary">
            first seen {bug.firstSeenAt.toLocaleDateString()}
          </span>
        </div>
        <h1 className="mt-2 text-2xl font-medium tracking-tight text-text-primary">{bug.title}</h1>
        <BugDescription description={latest?.whatHappened ?? bug.description} />
        {subtitle !== "" && <p className="mt-2 font-mono text-2xs text-text-tertiary">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {adminActions}
        {adminActions != null && <Separator orientation="vertical" className="h-5" />}
        <Button
          size="sm"
          variant={isResolved ? "default" : "outline"}
          onClick={onToggleResolved}
          disabled={togglingResolved}
          aria-pressed={isResolved}
        >
          {isResolved ? <XCircleIcon size={14} /> : <CheckCircleIcon size={14} />}
          {isResolved ? "Reopen bug" : "Resolve bug"}
        </Button>
      </div>
    </header>
  );
}
