import { cn } from "../../lib/utils";
import { Skeleton } from "./skeleton";

const DEFAULT_ROWS = 5;

export interface TableSkeletonProps {
  rows?: number;
  /** Row height utility when the table's rows are not the default height, e.g. `"h-9"`. */
  rowClassName?: string;
  className?: string;
}

/**
 * The stack of row bars a loading table shows. Deliberately just the rows: the callers that wrap it in a
 * `Panel` with a real header, in a bordered box, or in nothing at all keep doing so, because that chrome is
 * static and should be painted for real rather than skeletoned.
 */
export function TableSkeleton({ rows = DEFAULT_ROWS, rowClassName, className }: TableSkeletonProps) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={cn("h-10 w-full", rowClassName)} />
      ))}
    </div>
  );
}
