"use client";

import { CaretLeftIcon } from "@phosphor-icons/react/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { cn } from "../../lib/utils";

/**
 * How many numbered pages sit around the current one before the list elides. Odd, so the current page sits in the
 * middle of a full window rather than off-centre.
 */
const WINDOW = 5;

/** The gap marker. Not a page, and never clickable - it stands in for the pages the window dropped. */
const ELLIPSIS = "ellipsis";

type PageSlot = number | typeof ELLIPSIS;

export interface PaginationProps {
  /** 1-based. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Rendered on the left, e.g. "292 pull requests". */
  label?: React.ReactNode;
  className?: string;
}

/**
 * First and last are always reachable, the current page always sits in a window of neighbours, and the gap between
 * those groups collapses to a single marker. Returns bare page numbers so the caller owns the markup.
 */
export function paginationSlots(page: number, pageCount: number): PageSlot[] {
  if (pageCount <= WINDOW + 2) return Array.from({ length: pageCount }, (_, index) => index + 1);

  const span = Math.floor(WINDOW / 2);
  // Clamp the window inside the list so it stays WINDOW wide at both ends rather than running off and shrinking.
  const start = Math.min(Math.max(page - span, 2), pageCount - WINDOW);
  const end = start + WINDOW - 1;

  const slots: PageSlot[] = [1];
  if (start > 2) slots.push(ELLIPSIS);
  for (let candidate = start; candidate <= end; candidate++) slots.push(candidate);
  if (end < pageCount - 1) slots.push(ELLIPSIS);
  slots.push(pageCount);
  return slots;
}

const STEP_CLASS =
  "flex items-center gap-1 px-2 py-1 font-mono text-3xs uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:text-text-secondary disabled:opacity-40 enabled:cursor-pointer enabled:text-text-primary enabled:hover:text-primary-ink";

export function Pagination({ page, pageCount, onPageChange, label, className }: PaginationProps) {
  // One page needs no controls; none at all means the list is empty and the caller is showing its own message.
  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label="Pagination"
      className={cn("flex items-center gap-3 border-t border-border-dim px-4 py-2.5", className)}
    >
      {label != null && <span className="font-mono text-3xs text-text-secondary">{label}</span>}

      <div className="ml-auto flex items-center gap-1">
        <button type="button" className={STEP_CLASS} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <CaretLeftIcon size={11} weight="bold" />
          Prev
        </button>

        {paginationSlots(page, pageCount).map((slot, index) =>
          slot === ELLIPSIS ? (
            <span
              // Two markers can coexist and neither carries a value, so position is the only stable key.
              key={`gap-${index}`}
              className="px-1 font-mono text-3xs text-text-secondary"
              aria-hidden
            >
              ...
            </span>
          ) : (
            <button
              key={slot}
              type="button"
              aria-current={slot === page ? "page" : undefined}
              onClick={() => onPageChange(slot)}
              className={cn(
                "min-w-6 cursor-pointer px-1.5 py-1 text-center font-mono text-3xs transition-colors",
                slot === page ? "bg-primary font-bold text-background" : "text-text-secondary hover:text-text-primary",
              )}
            >
              {slot}
            </button>
          ),
        )}

        <button
          type="button"
          className={STEP_CLASS}
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Next
          <CaretRightIcon size={11} weight="bold" />
        </button>
      </div>
    </nav>
  );
}
