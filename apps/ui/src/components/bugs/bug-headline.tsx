import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@autonoma/blacklight";
import type { BugVerdict } from "@autonoma/types";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react/DotsThreeVertical";
import { ThumbsDownIcon } from "@phosphor-icons/react/ThumbsDown";
import { ThumbsUpIcon } from "@phosphor-icons/react/ThumbsUp";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import type { RouterOutputs } from "lib/trpc";

type BugDetail = RouterOutputs["bugs"]["detail"];

type SeverityBadgeVariant = "critical" | "high" | "warn" | "secondary";
type StatusBadgeVariant = "status-failed" | "success" | "warn";

const SEVERITY_BADGE: Record<string, SeverityBadgeVariant> = {
  critical: "critical",
  high: "high",
  medium: "warn",
  low: "secondary",
};

const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
  open: "status-failed",
  resolved: "success",
  regressed: "warn",
};

// Admin-only true/false-positive classification, kept out of the primary action lane so
// Resolve/Reopen stays the one prominent control. Absent for non-admins / when disabled.
interface BugClassification {
  verdict: BugVerdict | undefined;
  onClassify: (verdict: BugVerdict) => void;
  classifying: boolean;
}

export function BugHeadline({
  bug,
  onToggleResolved,
  togglingResolved,
  classification,
}: {
  bug: BugDetail;
  onToggleResolved: () => void;
  togglingResolved: boolean;
  classification?: BugClassification;
}) {
  const isResolved = bug.status === "resolved";

  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={SEVERITY_BADGE[bug.severity] ?? "secondary"}>{bug.severity}</Badge>
          <Badge variant={STATUS_BADGE[bug.status] ?? "secondary"}>{bug.status}</Badge>
        </div>
        <h1 className="mt-2 text-2xl font-medium tracking-tight text-text-primary">{bug.title}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
        {classification != null && <ClassificationMenu classification={classification} />}
      </div>
    </header>
  );
}

function ClassificationMenu({ classification }: { classification: BugClassification }) {
  const { verdict, onClassify, classifying } = classification;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label="Classify bug" disabled={classifying}>
            <DotsThreeVerticalIcon size={16} />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => onClassify("true_positive")}
          className={verdict === "true_positive" ? "text-status-success" : undefined}
        >
          <ThumbsUpIcon size={14} />
          True positive
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onClassify("false_positive")}
          className={verdict === "false_positive" ? "text-status-critical" : undefined}
        >
          <ThumbsDownIcon size={14} />
          False positive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
