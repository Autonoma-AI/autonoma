import type * as React from "react";
import { Fragment, useMemo } from "react";
import { type DiffLine, type DiffOptions, type InlineSegment, parseSources } from "../../lib/diff";
import { cn } from "../../lib/utils";

/**
 * Visual treatment per line kind: row tint, gutter accent, and marker glyph.
 * The accent's width lives on the row base (see {@link ROW_BASE}) rather than
 * here, so a tinted line and an untouched one indent identically.
 */
const ROW_STYLES = {
  add: {
    row: "bg-status-success/10 border-status-success",
    marker: "text-status-success",
    glyph: "+",
  },
  delete: {
    row: "bg-status-critical/10 border-status-critical",
    marker: "text-status-critical",
    glyph: "-",
  },
  "moved-from": {
    row: "bg-status-pending/10 border-status-pending",
    marker: "text-status-pending",
    glyph: "-",
  },
  "moved-to": {
    row: "bg-status-pending/10 border-status-pending",
    marker: "text-status-pending",
    glyph: "+",
  },
  "near-from": {
    row: "bg-status-high/10 border-status-high",
    marker: "text-status-high",
    glyph: "-",
  },
  "near-to": {
    row: "bg-status-high/10 border-status-high",
    marker: "text-status-high",
    glyph: "+",
  },
} as const;

/**
 * Every row reserves the accent stripe, transparent until a line earns a colour.
 * Without it the stripe would be extra width on changed lines only, nudging them
 * out of column with the context around them.
 */
const ROW_BASE = "flex border-l-2 border-transparent";

type RowStyle = (typeof ROW_STYLES)[keyof typeof ROW_STYLES];

/** Stronger tint for the changed runs inside a line's word-level diff. */
const SEGMENT_HIGHLIGHT = {
  add: "bg-status-success/30",
  delete: "bg-status-critical/30",
  near: "bg-status-high/30",
} as const;

export interface DiffProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** The text before the change. Empty string renders `newSource` as a pure addition. */
  oldSource: string;
  /** The text after the change. Empty string renders `oldSource` as a pure deletion. */
  newSource: string;
  /**
   * Layout: `unified` stacks old and new in one column (one row per line);
   * `split` puts the old version on the left and the new on the right, aligning
   * each removed line with the line that replaced it. Default `unified`.
   */
  view?: "unified" | "split";
  /** Show the old/new line number gutter. Default `true`. */
  showLineNumbers?: boolean;
  /** Tuning for whitespace collapse, move detection, and context. */
  options?: DiffOptions;
}

/**
 * Renders a diff of two texts as a line-numbered grid. Additions and deletions
 * get the usual treatment; relocated blocks (and near-matches - a move plus a
 * small edit) are tinted distinctly so they read as moves, not churn. `view`
 * selects a single unified column or an old-vs-new split.
 *
 * The diff-domain logic - patching, whitespace collapse, move detection - lives
 * in `lib/diff`; this component only paints the result.
 */
function Diff({
  oldSource,
  newSource,
  view = "unified",
  showLineNumbers = true,
  options,
  className,
  ...props
}: DiffProps) {
  const lines = useMemo(() => parseSources(oldSource, newSource, options), [oldSource, newSource, options]);
  // A lone hunk spanning the whole text carries no navigational information, so
  // its `@@ ... @@` header is suppressed; with several, they mark the elisions.
  const showHunkHeaders = lines.filter((line) => line.kind === "hunk").length > 1;

  const shared = { lines, showLineNumbers, showHunkHeaders };
  return (
    <div
      data-slot="diff"
      className={cn("border border-border-dim bg-surface-void font-mono text-2xs leading-relaxed", className)}
      {...props}
    >
      {view === "split" ? <SplitView {...shared} /> : <UnifiedView {...shared} />}
    </div>
  );
}

interface ViewProps {
  lines: DiffLine[];
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
}

function UnifiedView({ lines, showLineNumbers, showHunkHeaders }: ViewProps) {
  return (
    <div>
      {lines.map((line, index) => {
        if (line.kind === "hunk") {
          return showHunkHeaders ? <HunkHeader key={index} header={line.header} /> : undefined;
        }
        return <Row key={index} cell={toCell(line)} showLineNumbers={showLineNumbers} />;
      })}
    </div>
  );
}

function SplitView({ lines, showLineNumbers, showHunkHeaders }: ViewProps) {
  const rows = useMemo(() => toSplitRows(lines), [lines]);
  return (
    <div className="grid grid-cols-2">
      {rows.map((row, index) => {
        if (row.kind === "hunk") {
          return showHunkHeaders ? <HunkHeader key={index} header={row.header} className="col-span-2" /> : undefined;
        }
        return (
          <Fragment key={index}>
            <SplitCell cell={row.left} side="left" showLineNumbers={showLineNumbers} />
            <SplitCell cell={row.right} side="right" showLineNumbers={showLineNumbers} />
          </Fragment>
        );
      })}
    </div>
  );
}

function HunkHeader({ header, className }: { header: string; className?: string }) {
  return (
    <div data-slot="diff-hunk" className={cn("select-none bg-surface-raised px-3 py-1 text-text-secondary", className)}>
      {header}
    </div>
  );
}

/**
 * One rendered line, styled by the kind it earns. `style`/`segments`/`highlight`
 * are absent on context - an unchanged line carries no tint or intra-line mark.
 */
interface CellData {
  content: string;
  lineNo?: number;
  style?: RowStyle;
  segments?: InlineSegment[];
  highlight?: string;
  title?: string;
}

/** The cell for one diff line - never called for hunk lines. */
function toCell(line: Exclude<DiffLine, { kind: "hunk" }>): CellData {
  switch (line.kind) {
    case "context":
      return { content: line.content, lineNo: line.newLine };
    case "add":
      return {
        content: line.content,
        lineNo: line.newLine,
        style: ROW_STYLES.add,
        segments: line.segments,
        highlight: SEGMENT_HIGHLIGHT.add,
      };
    case "delete":
      return {
        content: line.content,
        lineNo: line.oldLine,
        style: ROW_STYLES.delete,
        segments: line.segments,
        highlight: SEGMENT_HIGHLIGHT.delete,
      };
    case "moved":
      return {
        content: line.content,
        lineNo: line.direction === "from" ? line.oldLine : line.newLine,
        style: line.direction === "from" ? ROW_STYLES["moved-from"] : ROW_STYLES["moved-to"],
        title: `Moved (block ${line.blockId})`,
      };
    case "near-match":
      return {
        content: line.content,
        lineNo: line.direction === "from" ? line.oldLine : line.newLine,
        style: line.direction === "from" ? ROW_STYLES["near-from"] : ROW_STYLES["near-to"],
        segments: line.segments,
        highlight: SEGMENT_HIGHLIGHT.near,
        title: `Moved with edits (block ${line.blockId})`,
      };
  }
}

function Row({ cell, showLineNumbers, className }: { cell: CellData; showLineNumbers: boolean; className?: string }) {
  return (
    <div className={cn(ROW_BASE, cell.style?.row, className)} title={cell.title}>
      {showLineNumbers && <Gutter value={cell.lineNo} />}
      <span className={cn("w-5 shrink-0 select-none text-center", cell.style?.marker)}>{cell.style?.glyph}</span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2">
        <LineContent content={cell.content} segments={cell.segments} highlight={cell.highlight} />
      </code>
    </div>
  );
}

function Gutter({ value }: { value?: number }) {
  return (
    <span className="w-12 shrink-0 select-none px-2 text-right tabular-nums text-text-secondary/70">{value ?? ""}</span>
  );
}

/** A split-view row: a full-width hunk header, or an old/new cell pair. */
type SplitRow = { kind: "hunk"; header: string } | { kind: "pair"; left?: CellData; right?: CellData };

const isRemoval = (line: DiffLine): boolean =>
  line.kind === "delete" || ((line.kind === "moved" || line.kind === "near-match") && line.direction === "from");

/**
 * Folds the flat unified model into split rows. Context becomes an identical
 * old/new pair; a run of removals is zipped against the following run of
 * additions so a replaced line sits beside its replacement, and any unmatched
 * remainder gets an empty cell on the other side. Relocated lines pair the same
 * way wherever their removal and addition runs land.
 */
function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line == null) break;
    if (line.kind === "hunk") {
      rows.push({ kind: "hunk", header: line.header });
      i++;
      continue;
    }
    if (line.kind === "context") {
      rows.push({
        kind: "pair",
        left: { content: line.content, lineNo: line.oldLine },
        right: { content: line.content, lineNo: line.newLine },
      });
      i++;
      continue;
    }

    // Every changed line in the run is one side or the other, so bucketing them
    // in a single pass both zips the pair and guarantees the walk advances.
    const removals: CellData[] = [];
    const additions: CellData[] = [];
    while (i < lines.length) {
      const next = lines[i];
      if (next == null || next.kind === "hunk" || next.kind === "context") break;
      if (isRemoval(next)) removals.push(toCell(next));
      else additions.push(toCell(next));
      i++;
    }
    const height = Math.max(removals.length, additions.length);
    for (let k = 0; k < height; k++) {
      rows.push({ kind: "pair", left: removals[k], right: additions[k] });
    }
  }
  return rows;
}

function SplitCell({
  cell,
  side,
  showLineNumbers,
}: {
  cell?: CellData;
  side: "left" | "right";
  showLineNumbers: boolean;
}) {
  // A right border splits the two halves; an empty cell is faintly shaded so a
  // one-sided change reads as "nothing here" rather than blank context.
  const divider = side === "left" ? "border-r border-border-dim" : undefined;
  if (cell == null) {
    return <div className={cn("bg-surface-raised/40", divider)} />;
  }
  return <Row cell={cell} showLineNumbers={showLineNumbers} className={divider} />;
}

/** Paints a line, tinting the word-level runs that changed. */
function LineContent({
  content,
  segments,
  highlight,
}: {
  content: string;
  segments?: InlineSegment[];
  highlight?: string;
}) {
  if (segments == null || highlight == null) return <>{content}</>;
  return (
    <>
      {segments.map((segment, index) => (
        <span key={index} className={cn(segment.changed && highlight)}>
          {segment.text}
        </span>
      ))}
    </>
  );
}

export { Diff };
